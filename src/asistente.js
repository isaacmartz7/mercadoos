const NETO = "CASE WHEN estado='devolucion' THEN -total ELSE total END";
const NETO_V = "CASE WHEN v.estado='devolucion' THEN -v.total ELSE v.total END";

const CONFIRMAR = /^(si|confirmo|confirmar|ok|dale|aplica|aplicar|adelante)$/;
const CANCELAR = /^(no|nop|cancelar|cancela)$/;

function norm(texto) {
  return String(texto || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[¿?¡!.,;:]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function numero(texto) {
  const n = Number(String(texto || "").replace(",", "."));
  if (!Number.isFinite(n)) return null;
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function filtroDePeriodo(periodo, extra) {
  const datos = extra || {};
  if (periodo === "mes") {
    return {
      periodo: "mes",
      etiqueta: "Este mes",
      sql: "strftime('%Y-%m', fecha) = strftime('%Y-%m', 'now', 'localtime')",
      params: [],
      desde: "",
      hasta: ""
    };
  }
  if (periodo === "ano") {
    return {
      periodo: "ano",
      etiqueta: "Este año",
      sql: "strftime('%Y', fecha) = strftime('%Y', 'now', 'localtime')",
      params: [],
      desde: "",
      hasta: ""
    };
  }
  if (periodo === "rango") {
    const desde = String(datos.desde || "");
    const hasta = String(datos.hasta || "");
    const iso = /^\d{4}-\d{2}-\d{2}$/;
    if (!iso.test(desde) || !iso.test(hasta) || desde > hasta) {
      return {
        periodo: "rango",
        etiqueta: "Rango",
        error: "Elige una fecha inicial y una final. La inicial tiene que ser la primera.",
        sql: null,
        params: [],
        desde,
        hasta
      };
    }
    return {
      periodo: "rango",
      etiqueta: `${desde} a ${hasta}`,
      sql: "date(fecha) >= ? AND date(fecha) <= ?",
      params: [desde, hasta],
      desde,
      hasta
    };
  }
  return {
    periodo: "dia",
    etiqueta: "Hoy",
    sql: "date(fecha) = date('now','localtime')",
    params: [],
    desde: "",
    hasta: ""
  };
}

function sqlFecha(filtro, columna) {
  return filtro.sql.replace(/\bfecha\b/g, columna);
}

function resumenVentas(get, filtro) {
  return get(
    `SELECT
       COALESCE(SUM(CASE WHEN estado='completada' THEN total ELSE 0 END), 0) AS ventas,
       COALESCE(SUM(CASE WHEN estado='completada' THEN 1 ELSE 0 END), 0) AS tickets,
       COALESCE(SUM(CASE WHEN estado='devolucion' THEN total ELSE 0 END), 0) AS devoluciones,
       COALESCE(SUM(CASE WHEN estado='devolucion' THEN 1 ELSE 0 END), 0) AS nDevoluciones,
       COALESCE(SUM(${NETO}), 0) AS neto
     FROM ventas
     WHERE estado IN ('completada','devolucion') AND ${filtro.sql}`,
    filtro.params
  );
}

function topProductos(all, filtro) {
  return all(
    `SELECT p.nombre,
       SUM(CASE WHEN v.estado='devolucion' THEN -d.cantidad ELSE d.cantidad END) AS cantidad,
       SUM(CASE WHEN v.estado='devolucion' THEN -d.subtotal ELSE d.subtotal END) AS total
     FROM detalle_ventas d
     JOIN ventas v ON v.id = d.venta_id
     JOIN productos p ON p.id = d.producto_id
     WHERE v.estado IN ('completada','devolucion') AND ${sqlFecha(filtro, "v.fecha")}
     GROUP BY p.id
     HAVING cantidad > 0
     ORDER BY cantidad DESC LIMIT 10`,
    filtro.params
  );
}

function cargarReportes(db, filtro) {
  const { get, all, round2 } = db;
  const vacio = {
    ventas: 0,
    tickets: 0,
    devoluciones: 0,
    nDevoluciones: 0,
    neto: 0
  };
  if (!filtro.sql) {
    return {
      resumen: vacio,
      margen: 0,
      porCajero: [],
      masVendidos: [],
      semana: vacio,
      stockBajo: [],
      sinMovimiento: [],
      sinMovimientoN: 0
    };
  }
  const resumen = resumenVentas(get, filtro);
  const semana = resumenVentas(get, {
    sql: "date(fecha)>=date('now','localtime','-6 day')",
    params: []
  });
  const porCajero = all(
    `SELECT COALESCE(NULLIF(v.cajero_nombre, ''), u.usuario) AS nombre,
       SUM(CASE WHEN v.estado='completada' THEN 1 ELSE 0 END) AS n,
       SUM(${NETO_V}) AS total
     FROM ventas v JOIN usuarios u ON u.id = v.usuario_id
     WHERE v.estado IN ('completada','devolucion') AND ${sqlFecha(filtro, "v.fecha")}
     GROUP BY COALESCE(NULLIF(v.cajero_nombre, ''), u.usuario)
     ORDER BY total DESC`,
    filtro.params
  );
  const margenRow = get(
    `SELECT COALESCE(SUM(
       CASE WHEN v.estado='devolucion' THEN -(d.subtotal - d.cantidad * p.costo)
            ELSE (d.subtotal - d.cantidad * p.costo) END
     ), 0) AS bruto
     FROM detalle_ventas d
     JOIN ventas v ON v.id = d.venta_id
     JOIN productos p ON p.id = d.producto_id
     WHERE v.estado IN ('completada','devolucion') AND ${sqlFecha(filtro, "v.fecha")}`,
    filtro.params
  );
  const descuentos = get(
    `SELECT COALESCE(SUM(descuento), 0) AS total
     FROM ventas
     WHERE estado='completada' AND ${filtro.sql}`,
    filtro.params
  );
  const stockBajo = all(
    `SELECT p.*, c.nombre AS categoria
     FROM productos p LEFT JOIN categorias c ON c.id = p.categoria_id
     WHERE p.activo=1 AND p.stock <= p.stock_minimo
     ORDER BY p.stock ASC`
  );
  const sinMovimientoWhere = `p.activo=1 AND NOT EXISTS (
       SELECT 1 FROM detalle_ventas d
       JOIN ventas v ON v.id = d.venta_id
       WHERE d.producto_id = p.id AND v.estado IN ('completada','devolucion')
         AND date(v.fecha) >= date('now','localtime','-30 day')
     )`;
  const sinMovimientoN = get(`SELECT COUNT(*) AS n FROM productos p WHERE ${sinMovimientoWhere}`).n;
  const sinMovimiento = all(
    `SELECT p.nombre, p.stock, p.unidad
     FROM productos p
     WHERE ${sinMovimientoWhere}
     ORDER BY p.stock DESC, p.nombre
     LIMIT 8`
  );
  return {
    resumen,
    margen: round2(margenRow.bruto - descuentos.total),
    porCajero,
    masVendidos: topProductos(all, filtro),
    semana,
    stockBajo,
    sinMovimiento,
    sinMovimientoN
  };
}

function singular(parte) {
  if (parte.length > 3 && parte.endsWith("s") && !parte.endsWith("ss")) return parte.slice(0, -1);
  return parte;
}

function tokensProducto(frase) {
  const stop = new Set([
    "la", "el", "los", "las", "de", "del", "un", "una", "unos", "unas",
    "unidad", "unidades", "litro", "litros", "lb", "kg"
  ]);
  return norm(frase)
    .split(" ")
    .filter((parte) => parte && !stop.has(parte))
    .map(singular)
    .filter((parte) => parte && !stop.has(parte));
}

function buscarProductos(all, frase) {
  const partes = tokensProducto(frase);
  const crudo = norm(frase);
  if (!partes.length && !crudo) return [];
  const rows = all(
    `SELECT id, nombre, codigo_barras, stock, unidad, precio_venta, costo, impuesto
     FROM productos WHERE activo=1`
  );
  const scored = [];
  for (const producto of rows) {
    const nombre = norm(producto.nombre);
    const codigo = norm(producto.codigo_barras);
    let score = 0;
    if (codigo && (codigo === crudo || codigo === partes.join(""))) score = 100;
    else if (nombre === crudo || nombre === partes.join(" ")) score = 100;
    else if (partes.length && partes.every((parte) => nombre.includes(parte))) score = 70 + Math.min(partes.join(" ").length, 20);
    else if (partes.some((parte) => parte.length >= 4 && nombre.includes(parte))) score = 45;
    if (score) scored.push({ producto, score });
  }
  scored.sort((a, b) => b.score - a.score || a.producto.nombre.localeCompare(b.producto.nombre, "es"));
  if (!scored.length) return [];
  const mejor = scored[0].score;
  return scored.filter((item) => item.score >= mejor - 5 && item.score >= 45).map((item) => item.producto);
}

function periodoEn(texto) {
  if (/\b(hoy|del dia|este dia)\b/.test(texto)) return "dia";
  if (/\b(ano|anual)\b/.test(texto)) return "ano";
  if (/\bmes\b/.test(texto)) return "mes";
  return null;
}

function comandoDesde(texto) {
  let match;
  match = texto.match(/^(?:nota de )?devolucion(?: de)?\s+(\d+(?:[.,]\d+)?)(?:\s+(?:unidades?\s+)?(?:de\s+)?(.+))?$/);
  if (!match) match = texto.match(/^devolvieron\s+(\d+(?:[.,]\d+)?)(?:\s+(?:unidades?\s+)?(?:de\s+)?(.+))?$/);
  if (!match) match = texto.match(/^devolver\s+(\d+(?:[.,]\d+)?)(?:\s+(?:unidades?\s+)?(?:de\s+)?(.+))?$/);
  if (match) return { tipo: "devolucion", cantidad: numero(match[1]), producto: match[2] || "" };

  match = texto.match(/^(?:entraron|entro|ingresaron|ingreso|recibimos|recibo|llegaron|llego)\s+(\d+(?:[.,]\d+)?)(?:\s+(?:unidades?\s+)?(?:de\s+)?(.+))?$/);
  if (match) return { tipo: "entrada", cantidad: numero(match[1]), producto: match[2] || "" };

  match = texto.match(/^(?:la |el |los |las )?(.+?)\s+queda(?:n)? en\s+(\d+(?:[.,]\d+)?)$/);
  if (!match) match = texto.match(/^deja(?:r)?\s+(?:la |el |los |las )?(.+?)\s+en\s+(\d+(?:[.,]\d+)?)$/);
  if (!match) match = texto.match(/^ajust(?:ar|a)\s+(?:la |el |los |las )?(.+?)\s+a\s+(\d+(?:[.,]\d+)?)$/);
  if (match) return { tipo: "ajuste", cantidad: numero(match[2]), producto: match[1] || "" };

  match = texto.match(/^(?:ultimos?\s+)?movimientos?\s+(?:de\s+)?(?:la |el |los |las )?(.+)$/);
  if (!match) match = texto.match(/^que (?:paso|ha pasado) con\s+(?:la |el |los |las )?(.+)$/);
  if (match) return { tipo: "movimientos", producto: match[1] || "" };

  if (/\b(por acabarse|stock bajo|se esta acabando|hay que reponer|bajo el minimo)\b/.test(texto)) {
    return { tipo: "bajos" };
  }

  if (/\b(vendio|vendimos|venta|ventas)\b/.test(texto)) {
    return { tipo: "ventas", periodo: periodoEn(texto) };
  }

  match = texto.match(/^(?:cuanta|cuanto|cuantas|cuantos)\s+(.+?)\s+(?:queda|quedan|hay|tenemos)$/);
  if (!match) match = texto.match(/^(?:stock|existencia|existencias)\s+(?:de\s+)?(.+)$/);
  if (!match) match = texto.match(/^(?:hay|queda|quedan|tenemos)\s+(.+)$/);
  if (match) return { tipo: "stock", producto: match[1] || "" };

  return null;
}

function listaProductos(productos) {
  return productos.map((producto, indice) => `${indice + 1}. ${producto.nombre}`).join("\n");
}

function textoVentas(money, moneda, etiqueta, row) {
  const neto = Number(row.neto) || 0;
  const tickets = Number(row.tickets) || 0;
  const devoluciones = Number(row.devoluciones) || 0;
  const ventas = Number(row.ventas) || 0;
  const ticketTxt = tickets === 1 ? "1 ticket" : `${tickets} tickets`;
  if (devoluciones > 0) {
    return `${etiqueta}: ${moneda} ${money(neto)} netos, ${ticketTxt}. Las ventas suman ${moneda} ${money(ventas)} y las devoluciones restan ${moneda} ${money(devoluciones)}.`;
  }
  return `${etiqueta}: ${moneda} ${money(neto)}, ${ticketTxt}. No hay devoluciones en ese periodo.`;
}

function interpretar(ctx) {
  const texto = norm(ctx.texto);
  const money = ctx.money;
  const moneda = ctx.moneda || "L";
  let pendiente = ctx.pendiente || null;

  if (!texto) {
    return { respuestas: ["Escribe una frase corta. Por ejemplo: cuánta leche queda."], pendiente };
  }

  if (CANCELAR.test(texto)) {
    if (!pendiente) return { respuestas: ["No había nada pendiente."], pendiente: null };
    return { respuestas: ["Cancelado. No cambié el stock."], pendiente: null };
  }

  if (CONFIRMAR.test(texto)) {
    if (!pendiente || pendiente.op === "elegir" || pendiente.op === "aclarar") {
      return {
        respuestas: ["No hay un cambio listo para aplicar. Si quieres anotar stock, dime el producto y la cantidad."],
        pendiente
      };
    }
    if ((pendiente.op === "entrada" || pendiente.op === "ajuste") && !ctx.puedeAjustar) {
      return { respuestas: ["Tu rol no puede cambiar el stock. No apliqué nada."], pendiente: null };
    }
    if (pendiente.op === "devolucion" && !ctx.puedeDevolver) {
      return { respuestas: ["Tu rol no puede registrar devoluciones. No apliqué nada."], pendiente: null };
    }
    return { respuestas: [], pendiente: null, aplicar: pendiente };
  }

  if (pendiente && pendiente.op === "elegir" && /^\d+$/.test(texto)) {
    const indice = Number(texto) - 1;
    const id = pendiente.ids[indice];
    if (!id) {
      return { respuestas: ["Ese número no está en la lista."], pendiente };
    }
    return resolverProducto(ctx, pendiente.intent, id, null);
  }

  if (pendiente && pendiente.op === "elegir" && !comandoDesde(texto)) {
    return resolverProducto(ctx, pendiente.intent, null, texto);
  }

  if (pendiente && pendiente.op === "aclarar") {
    const comandoNuevo = comandoDesde(texto);
    if (!comandoNuevo) {
      if (pendiente.falta === "periodo") {
        const periodo = periodoEn(texto);
        if (!periodo) {
          return { respuestas: ["¿Hoy, este mes o este año?"], pendiente };
        }
        return responderVentas(ctx, periodo);
      }
      if (pendiente.falta === "producto") {
        return resolverProducto(ctx, pendiente.intent, null, texto);
      }
      if (pendiente.falta === "cantidad") {
        const cantidad = numero(texto);
        if (cantidad == null) {
          return { respuestas: ["¿Cuántas unidades?"], pendiente };
        }
        return resolverProducto(ctx, { ...pendiente.intent, cantidad }, pendiente.intent.productoId || null, pendiente.intent.producto || "");
      }
    }
  }

  const comando = comandoDesde(texto);
  if (!comando) {
    return {
      respuestas: [
        "No entendí esa frase, así que no anoté nada. Puedo decirte cuánta existencia hay de un producto, qué está por acabarse, cuánto se vendió hoy, este mes o este año, y los últimos movimientos. También preparo entradas («entraron 12 leches»), ajustes («la leche queda en 5») y una devolución si tu rol y el turno de caja lo permiten. El cambio solo se aplica cuando respondes sí."
      ],
      pendiente: null
    };
  }

  if (comando.tipo === "bajos") return responderBajos(ctx);
  if (comando.tipo === "ventas") {
    if (!comando.periodo) {
      return {
        respuestas: ["¿De qué periodo? Responde hoy, este mes o este año."],
        pendiente: { op: "aclarar", falta: "periodo" }
      };
    }
    return responderVentas(ctx, comando.periodo);
  }
  return resolverProducto(ctx, comando, null, comando.producto);
}

function responderBajos(ctx) {
  const rows = ctx.all(
    `SELECT nombre, stock, unidad, stock_minimo
     FROM productos
     WHERE activo=1 AND stock <= stock_minimo
     ORDER BY stock ASC, nombre`
  );
  if (!rows.length) {
    return { respuestas: ["Ningún producto activo está en el mínimo o por debajo."], pendiente: null };
  }
  const lineas = rows.map((row) => `${row.nombre}: ${ctx.money(row.stock)} ${row.unidad} (mínimo ${ctx.money(row.stock_minimo)})`);
  return {
    respuestas: [`Estos productos están por acabarse:\n${lineas.join("\n")}`],
    pendiente: null
  };
}

function responderVentas(ctx, periodo) {
  if (!ctx.puedeReportes) {
    return {
      respuestas: ["Tu rol puede consultar inventario en el asistente. Los totales de venta los ven gerencia y administración."],
      pendiente: null
    };
  }
  const filtro = filtroDePeriodo(periodo);
  const row = resumenVentas(ctx.get, filtro);
  return {
    respuestas: [textoVentas(ctx.money, ctx.moneda, filtro.etiqueta, row)],
    pendiente: null
  };
}

function responderStock(ctx, producto) {
  return {
    respuestas: [`${producto.nombre}: ${ctx.money(producto.stock)} ${producto.unidad} en existencia.`],
    pendiente: null
  };
}

function responderMovimientos(ctx, producto) {
  const rows = ctx.all(
    `SELECT tipo, cantidad, stock_nuevo, referencia, fecha
     FROM movimientos_inventario
     WHERE producto_id=?
     ORDER BY id DESC LIMIT 8`,
    [producto.id]
  );
  if (!rows.length) {
    return { respuestas: [`${producto.nombre} no tiene movimientos.`], pendiente: null };
  }
  const lineas = rows.map((row) => {
    const ref = row.referencia ? ` · ${row.referencia}` : "";
    return `${row.fecha} · ${row.tipo} · ${ctx.money(row.cantidad)} · queda ${ctx.money(row.stock_nuevo)}${ref}`;
  });
  return {
    respuestas: [`Últimos movimientos de ${producto.nombre}:\n${lineas.join("\n")}`],
    pendiente: null
  };
}

function resolverProducto(ctx, intent, productoId, frase) {
  let producto = null;
  if (productoId) {
    producto = ctx.get(
      `SELECT id, nombre, codigo_barras, stock, unidad, precio_venta, costo, impuesto
       FROM productos WHERE id=? AND activo=1`,
      [productoId]
    );
    if (!producto) {
      return { respuestas: ["Ese producto ya no está activo. No cambié nada."], pendiente: null };
    }
  } else {
    const fraseLimpia = String(frase || "").trim();
    if (!fraseLimpia) {
      return {
        respuestas: ["¿De qué producto?"],
        pendiente: { op: "aclarar", falta: "producto", intent }
      };
    }
    const encontrados = buscarProductos(ctx.all, fraseLimpia);
    if (!encontrados.length) {
      return {
        respuestas: [`No encontré «${fraseLimpia}» entre los productos activos. No cambié nada.`],
        pendiente: null
      };
    }
    if (encontrados.length > 6) {
      return {
        respuestas: ["Hay varios productos parecidos. Dime el nombre con más detalle."],
        pendiente: null
      };
    }
    if (encontrados.length > 1) {
      return {
        respuestas: [`Encontré más de uno. Responde con el número:\n${listaProductos(encontrados)}`],
        pendiente: {
          op: "elegir",
          ids: encontrados.map((item) => item.id),
          intent: { ...intent, producto: fraseLimpia }
        }
      };
    }
    producto = encontrados[0];
  }

  if (intent.tipo === "stock") return responderStock(ctx, producto);
  if (intent.tipo === "movimientos") return responderMovimientos(ctx, producto);

  if (intent.cantidad == null || intent.cantidad < 0 || (intent.tipo !== "ajuste" && intent.cantidad <= 0)) {
    return {
      respuestas: [`¿Cuántas unidades de ${producto.nombre}?`],
      pendiente: { op: "aclarar", falta: "cantidad", intent: { ...intent, productoId: producto.id, producto: producto.nombre } }
    };
  }
  if (intent.cantidad > 100000) {
    return { respuestas: ["Esa cantidad es demasiado alta. No preparé ningún cambio."], pendiente: null };
  }

  if (intent.tipo === "entrada" || intent.tipo === "ajuste") {
    if (!ctx.puedeAjustar) {
      return {
        respuestas: ["Tu rol puede consultar el asistente, pero no puede cambiar el stock."],
        pendiente: null
      };
    }
  }
  if (intent.tipo === "devolucion") {
    if (!ctx.puedeDevolver) {
      return {
        respuestas: ["Tu rol no registra devoluciones. En caja se anotan con un turno abierto."],
        pendiente: null
      };
    }
    if (!ctx.turnoAbierto) {
      return {
        respuestas: ["Para anotar la devolución hace falta un turno abierto en caja, igual que en el mostrador. Así no se descuadra el efectivo. No preparé ningún cambio."],
        pendiente: null
      };
    }
  }

  return proponer(ctx, intent, producto);
}

function proponer(ctx, intent, producto) {
  const money = ctx.money;
  const actual = Number(producto.stock) || 0;
  if (intent.tipo === "entrada") {
    const nuevo = Math.round((actual + intent.cantidad + Number.EPSILON) * 100) / 100;
    return {
      respuestas: [
        `Voy a sumar ${money(intent.cantidad)} a ${producto.nombre}. El stock pasaría de ${money(actual)} a ${money(nuevo)} ${producto.unidad} y quedaría un movimiento de entrada. Responde sí para aplicarlo o no para cancelar.`
      ],
      pendiente: { op: "entrada", productoId: producto.id, cantidad: intent.cantidad }
    };
  }
  if (intent.tipo === "ajuste") {
    const destino = intent.cantidad;
    const delta = Math.round((destino - actual + Number.EPSILON) * 100) / 100;
    if (destino < 0) {
      return { respuestas: ["El stock no puede quedar negativo. No preparé ningún cambio."], pendiente: null };
    }
    if (delta === 0) {
      return {
        respuestas: [`${producto.nombre} ya está en ${money(actual)} ${producto.unidad}. No preparé ningún cambio.`],
        pendiente: null
      };
    }
    return {
      respuestas: [
        `Voy a dejar ${producto.nombre} en ${money(destino)} ${producto.unidad}. Ahora tiene ${money(actual)}; el ajuste sería ${delta > 0 ? "+" : ""}${money(delta)}. Responde sí para aplicarlo o no para cancelar.`
      ],
      pendiente: { op: "ajuste", productoId: producto.id, cantidad: destino }
    };
  }
  if (intent.tipo === "devolucion") {
    const vendido = ctx.get(
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
      [producto.id]
    );
    const disponible = Number(vendido && vendido.neto) || 0;
    if (intent.cantidad > disponible + 0.001) {
      return {
        respuestas: [`Solo hay ${money(disponible)} de ${producto.nombre} vendido que se pueda devolver. No preparé ningún cambio.`],
        pendiente: null
      };
    }
    const nuevo = Math.round((actual + intent.cantidad + Number.EPSILON) * 100) / 100;
    const precio = Number(producto.precio_venta) || 0;
    const impuesto = Number(producto.impuesto) || 0;
    const subtotal = Math.round((precio * intent.cantidad + Number.EPSILON) * 100) / 100;
    const imp = Math.round((subtotal * impuesto + Number.EPSILON) * 100) / 100;
    const total = Math.round((subtotal + imp + Number.EPSILON) * 100) / 100;
    return {
      respuestas: [
        `Voy a registrar una devolución de ${money(intent.cantidad)} de ${producto.nombre} por ${ctx.moneda} ${money(total)} en efectivo, ligada al turno abierto. El stock pasaría de ${money(actual)} a ${money(nuevo)} ${producto.unidad}. Responde sí para aplicarlo o no para cancelar.`
      ],
      pendiente: { op: "devolucion", productoId: producto.id, cantidad: intent.cantidad }
    };
  }
  return { respuestas: ["No preparé ningún cambio."], pendiente: null };
}

module.exports = {
  filtroDePeriodo,
  cargarReportes,
  interpretar
};
