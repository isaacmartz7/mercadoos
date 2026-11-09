(() => {
  const moneda = window.MONEDA || "L";
  const carritoEl = document.getElementById("carrito");
  const buscar = document.getElementById("buscar");
  const resultados = document.getElementById("resultados");
  const errorEl = document.getElementById("pos-error");
  const descuentoEl = document.getElementById("descuento");
  const metodoEl = document.getElementById("metodo");
  const recibidoEl = document.getElementById("recibido");
  const wrapRecibido = document.getElementById("wrap-recibido");
  const cobrarBtn = document.getElementById("cobrar");
  const esperarBtn = document.getElementById("esperar");
  const consultaEl = document.getElementById("consulta");
  const reciboEl = document.getElementById("recibo");
  const esperaWrap = document.getElementById("espera-wrap");
  const esperaLista = document.getElementById("espera-lista");
  const reimprimir = document.getElementById("reimprimir");
  const turnoError = document.getElementById("turno-error");
  const turnoOk = document.getElementById("turno-ok");
  const cerrarForm = document.getElementById("cerrar-turno");
  const contadoEl = document.getElementById("contado");
  const holdKey = `mercadoos-espera-${window.USER_ID || "0"}`;
  const maxHolds = 5;

  let items = [];
  let turno = window.TURNO && window.TURNO.id ? { ...window.TURNO, abierto: true } : { abierto: false };
  let ultimaVenta = window.ULTIMA_VENTA || null;
  let searchSeq = 0;
  let highlight = -1;
  let cobrando = false;

  const fmt = (n) => `${moneda} ${Number(n).toFixed(2)}`;
  const round2 = (n) => Math.round((Number(n) + Number.EPSILON) * 100) / 100;
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);

  function showError(msg) {
    errorEl.textContent = msg || "";
    errorEl.classList.toggle("hidden", !msg);
  }

  function showTurnoError(msg) {
    turnoError.textContent = msg || "";
    turnoError.classList.toggle("hidden", !msg);
  }

  function showTurnoOk(msg) {
    turnoOk.textContent = msg || "";
    turnoOk.classList.toggle("hidden", !msg);
  }

  function totals() {
    let subtotal = 0;
    let impuesto = 0;
    items.forEach((it) => {
      const linea = it.precio_venta * it.cantidad;
      subtotal += linea;
      impuesto += linea * it.impuesto;
    });
    const descuento = Math.max(0, Number(descuentoEl.value) || 0);
    const total = round2(Math.max(0, subtotal + impuesto - descuento));
    return { subtotal: round2(subtotal), impuesto: round2(impuesto), descuento: round2(descuento), total };
  }

  function bloqueoCobro() {
    if (!turno.abierto) return "Abre el turno antes de cobrar.";
    if (!items.length) return "Agrega al menos un producto al ticket.";
    const t = totals();
    if (metodoEl.value === "efectivo" && (Number(recibidoEl.value) || 0) + 0.001 < t.total) {
      return "El efectivo recibido no cubre el total.";
    }
    return "";
  }

  function ticketUrl(id) {
    return `/ventas/${id}?imprimir=1`;
  }

  function paintReprint() {
    if (!ultimaVenta) {
      reimprimir.classList.add("hidden");
      return;
    }
    reimprimir.href = ticketUrl(ultimaVenta);
    reimprimir.classList.remove("hidden");
  }

  function loadHolds() {
    try {
      const parsed = JSON.parse(localStorage.getItem(holdKey) || "[]");
      return Array.isArray(parsed) ? parsed.slice(0, maxHolds) : [];
    } catch (error) {
      return [];
    }
  }

  function saveHolds(list) {
    localStorage.setItem(holdKey, JSON.stringify(list.slice(0, maxHolds)));
  }

  function renderHolds() {
    const holds = loadHolds();
    esperaWrap.classList.toggle("hidden", holds.length === 0);
    esperaLista.innerHTML = holds
      .map(
        (hold) => `<li>
          <span>${esc(hold.titulo)}<br><small>${hold.items.length === 1 ? "1 producto" : `${hold.items.length} productos`}</small></span>
          <span class="actions">
            <button type="button" class="btn" data-resume="${hold.id}">Retomar</button>
            <button type="button" class="btn-link" data-drop="${hold.id}">Descartar</button>
          </span>
        </li>`
      )
      .join("");
  }

  function renderCart() {
    carritoEl.innerHTML = items.length
      ? items
          .map((it, i) => {
            const linea = it.precio_venta * it.cantidad;
            return `<li>
              <span class="line-name">${esc(it.nombre)}<br><small>${fmt(it.precio_venta)} · quedan ${esc(it.stock)}</small></span>
              <div class="qty">
                <button type="button" data-dec="${i}" aria-label="Bajar cantidad de ${esc(it.nombre)}">−</button>
                <input type="number" min="0.01" step="0.01" value="${it.cantidad}" data-i="${i}" aria-label="Cantidad de ${esc(it.nombre)}" />
                <button type="button" data-inc="${i}" aria-label="Subir cantidad de ${esc(it.nombre)}">+</button>
              </div>
              <strong class="line-total" data-line="${i}">${fmt(linea)}</strong>
              <button type="button" class="btn-link" data-del="${i}">Quitar</button>
            </li>`;
          })
          .join("")
      : "<li class='muted'>El ticket está vacío. Busca un producto y agrégalo.</li>";
  }

  function renderTotals() {
    const t = totals();
    document.getElementById("subtotal").textContent = fmt(t.subtotal);
    document.getElementById("impuesto").textContent = fmt(t.impuesto);
    document.getElementById("total").textContent = fmt(t.total);
    const recibido = Number(recibidoEl.value) || 0;
    const cambio = metodoEl.value === "efectivo" ? Math.max(0, round2(recibido - t.total)) : 0;
    document.getElementById("cambio").textContent = fmt(cambio);
    const efectivo = metodoEl.value === "efectivo";
    wrapRecibido.classList.toggle("is-off", !efectivo);
    cobrarBtn.disabled = cobrando || Boolean(bloqueoCobro());
    esperarBtn.disabled = !items.length;
  }

  function render() {
    renderCart();
    renderTotals();
    renderHolds();
    paintReprint();
  }

  function paintTurno() {
    const abierto = Boolean(turno && turno.abierto);
    document.getElementById("turno-cerrado").classList.toggle("hidden", abierto);
    document.getElementById("turno-abierto").classList.toggle("hidden", !abierto);
    if (!abierto) {
      cerrarForm.classList.add("hidden");
      renderTotals();
      return;
    }
    document.getElementById("turno-desde").textContent = turno.apertura;
    document.getElementById("turno-fondo").textContent = fmt(turno.fondo);
    document.getElementById("turno-efectivo").textContent = fmt(turno.ventasEfectivo);
    document.getElementById("turno-tarjeta").textContent = fmt(turno.ventasTarjeta);
    document.getElementById("turno-esperado").textContent = fmt(turno.esperado);
    renderTotals();
  }

  function hideConsulta() {
    consultaEl.classList.add("hidden");
    consultaEl.innerHTML = "";
  }

  function showConsulta(prod) {
    consultaEl.classList.remove("hidden");
    consultaEl.innerHTML = `<p><strong>${esc(prod.nombre)}</strong></p><p>${fmt(prod.precio_venta)} · quedan ${esc(prod.stock)} ${esc(prod.unidad || "")}</p>`;
  }

  function hideRecibo() {
    reciboEl.classList.add("hidden");
  }

  function showRecibo(data) {
    document.getElementById("recibo-id").textContent = data.ventaId;
    document.getElementById("recibo-total").textContent = fmt(data.total);
    document.getElementById("recibo-cambio").textContent = fmt(data.cambio || 0);
    const print = document.getElementById("recibo-print");
    print.href = ticketUrl(data.ventaId);
    reciboEl.classList.remove("hidden");
  }

  function add(prod) {
    const found = items.find((it) => it.id === prod.id);
    const nextQty = found ? found.cantidad + 1 : 1;
    if (nextQty > prod.stock) {
      showError(`Stock insuficiente de ${prod.nombre}. Hay ${prod.stock}.`);
      return;
    }
    showError("");
    hideRecibo();
    if (found) found.cantidad = nextQty;
    else items.push({ ...prod, cantidad: 1 });
    render();
  }

  function setQty(index, qty) {
    const item = items[index];
    if (!item) return;
    if (qty > item.stock) {
      showError(`Stock insuficiente. Hay ${item.stock}.`);
      return;
    }
    if (qty <= 0) return;
    item.cantidad = qty;
    showError("");
    render();
  }

  function pickProduct(prod) {
    if (!prod) return;
    add(prod);
    resultados.innerHTML = "";
    buscar.value = "";
    highlight = -1;
    hideConsulta();
    buscar.focus();
  }

  function paintHighlight() {
    const buttons = resultados.querySelectorAll(".result");
    buttons.forEach((btn, i) => btn.classList.toggle("is-active", i === highlight));
    if (buttons[highlight]) buttons[highlight].scrollIntoView({ block: "nearest" });
  }

  async function search(q, instantAdd) {
    const seq = ++searchSeq;
    const res = await fetch(`/api/productos?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (seq !== searchSeq) return;
    if (instantAdd && data.length === 1 && data[0].codigo_barras === q) {
      hideConsulta();
      pickProduct(data[0]);
      return;
    }
    highlight = data.length ? 0 : -1;
    if (data.length === 1 && data[0].codigo_barras !== q) showConsulta(data[0]);
    else hideConsulta();
    resultados.innerHTML = data.length
      ? data
          .map(
            (p) => `<button type="button" class="result" data-id="${p.id}">
              <span>${esc(p.nombre)}<br><small>${esc(p.codigo_barras)} · quedan ${esc(p.stock)}</small></span>
              <strong>${fmt(p.precio_venta)}</strong>
            </button>`
          )
          .join("")
      : `<p class="muted">No encontramos “${esc(q)}”. Sigue escribiendo o prueba el código.</p>`;
    resultados.querySelectorAll(".result").forEach((btn) => {
      btn.addEventListener("click", () => {
        pickProduct(data.find((p) => String(p.id) === btn.dataset.id));
      });
    });
    paintHighlight();
  }

  function snapshotTicket() {
    const titulo = items.length > 1 ? `${items[0].nombre} +${items.length - 1}` : items[0].nombre;
    return {
      id: Date.now(),
      titulo,
      descuento: descuentoEl.value,
      items: items.map((it) => ({ ...it }))
    };
  }

  function clearTicket() {
    items = [];
    descuentoEl.value = "0";
    recibidoEl.value = "";
    render();
  }

  async function resumeHold(hold) {
    const refreshed = [];
    for (const it of hold.items) {
      const res = await fetch(`/api/productos?q=${encodeURIComponent(it.codigo_barras)}`);
      const data = await res.json();
      const fresh = data.find((p) => p.id === it.id);
      refreshed.push(fresh ? { ...fresh, cantidad: it.cantidad } : it);
    }
    items = refreshed;
    descuentoEl.value = hold.descuento || "0";
    hideRecibo();
    render();
    buscar.focus();
  }

  let debounce;
  buscar.addEventListener("input", () => {
    const q = buscar.value.trim();
    clearTimeout(debounce);
    if (!q) {
      searchSeq += 1;
      resultados.innerHTML = "";
      highlight = -1;
      hideConsulta();
      return;
    }
    debounce = setTimeout(() => search(q, false), 120);
  });

  buscar.addEventListener("keydown", (e) => {
    const buttons = resultados.querySelectorAll(".result");
    if (e.key === "ArrowDown" && buttons.length) {
      e.preventDefault();
      highlight = (highlight + 1) % buttons.length;
      paintHighlight();
    } else if (e.key === "ArrowUp" && buttons.length) {
      e.preventDefault();
      highlight = highlight <= 0 ? buttons.length - 1 : highlight - 1;
      paintHighlight();
    } else if (e.key === "Escape") {
      resultados.innerHTML = "";
      highlight = -1;
      buscar.value = "";
      hideConsulta();
    } else if (e.key === "Enter" && highlight >= 0 && buttons.length) {
      e.preventDefault();
      buttons[highlight].click();
    }
  });

  document.getElementById("buscar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = buscar.value.trim();
    if (q) search(q, true);
  });

  carritoEl.addEventListener("input", (e) => {
    const i = e.target.dataset.i;
    if (i == null) return;
    const qty = Number(e.target.value);
    if (!Number.isFinite(qty) || qty <= 0) return;
    if (qty > items[i].stock) {
      showError(`Stock insuficiente. Hay ${items[i].stock}.`);
      e.target.value = items[i].cantidad;
      return;
    }
    items[i].cantidad = qty;
    showError("");
    const line = carritoEl.querySelector(`[data-line="${i}"]`);
    if (line) line.textContent = fmt(items[i].precio_venta * qty);
    renderTotals();
  });

  carritoEl.addEventListener("click", (e) => {
    if (e.target.dataset.del != null) {
      items.splice(Number(e.target.dataset.del), 1);
      render();
      return;
    }
    if (e.target.dataset.inc != null) {
      const i = Number(e.target.dataset.inc);
      setQty(i, round2(items[i].cantidad + 1));
      return;
    }
    if (e.target.dataset.dec != null) {
      const i = Number(e.target.dataset.dec);
      if (items[i].cantidad > 1) setQty(i, round2(items[i].cantidad - 1));
    }
  });

  document.getElementById("billetes").addEventListener("click", (e) => {
    const bill = e.target.dataset.bill;
    if (!bill || metodoEl.value !== "efectivo") return;
    recibidoEl.value = bill === "exacto" ? totals().total.toFixed(2) : Number(bill).toFixed(2);
    renderTotals();
  });

  [descuentoEl, recibidoEl, metodoEl].forEach((el) => el.addEventListener("input", renderTotals));
  metodoEl.addEventListener("change", renderTotals);

  esperarBtn.addEventListener("click", () => {
    if (!items.length) return;
    const holds = loadHolds();
    if (holds.length >= maxHolds) {
      showError("Solo puedes tener 5 tickets en espera.");
      return;
    }
    holds.unshift(snapshotTicket());
    saveHolds(holds);
    clearTicket();
    showError("");
    buscar.focus();
  });

  esperaLista.addEventListener("click", async (e) => {
    const drop = e.target.dataset.drop;
    const resume = e.target.dataset.resume;
    if (drop == null && resume == null) return;
    let holds = loadHolds();
    if (drop != null) {
      saveHolds(holds.filter((hold) => String(hold.id) !== drop));
      renderHolds();
      return;
    }
    const hold = holds.find((item) => String(item.id) === resume);
    if (!hold) return;
    if (items.length && holds.length >= maxHolds) {
      showError("Cobra o descarta el ticket actual. La espera está llena.");
      return;
    }
    holds = holds.filter((item) => String(item.id) !== resume);
    if (items.length) holds.unshift(snapshotTicket());
    saveHolds(holds);
    showError("");
    await resumeHold(hold);
  });

  async function cobrar() {
    const reason = bloqueoCobro();
    if (reason) return showError(reason);
    if (cobrando) return;
    cobrando = true;
    renderTotals();
    const t = totals();
    const payload = {
      items: items.map((it) => ({ id: it.id, cantidad: it.cantidad })),
      metodo_pago: metodoEl.value,
      descuento: t.descuento,
      recibido: Number(recibidoEl.value)
    };
    try {
      const res = await fetch("/api/ventas", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) {
        showError(data.error || "No se pudo cobrar.");
        cobrando = false;
        renderTotals();
        return;
      }
      ultimaVenta = data.ventaId;
      items = [];
      descuentoEl.value = "0";
      recibidoEl.value = "";
      showError("");
      showRecibo(data);
      render();
      buscar.focus();
    } catch (error) {
      showError("No hay conexión con el servidor.");
    }
    cobrando = false;
    renderTotals();
  }

  cobrarBtn.addEventListener("click", cobrar);
  document.getElementById("recibo-listo").addEventListener("click", () => {
    hideRecibo();
    buscar.focus();
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "F2") {
      e.preventDefault();
      buscar.focus();
      buscar.select();
    } else if (e.key === "F4" || (e.key === "Enter" && (e.ctrlKey || e.metaKey))) {
      e.preventDefault();
      cobrar();
    } else if (e.key === "Escape") {
      hideRecibo();
    }
  });

  document.getElementById("abrir-turno").addEventListener("submit", async (e) => {
    e.preventDefault();
    showTurnoError("");
    showTurnoOk("");
    const fondo = Number(document.getElementById("fondo").value);
    try {
      const res = await fetch("/api/turno/abrir", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ fondo })
      });
      const data = await res.json();
      if (!res.ok) {
        showTurnoError(data.error || "No se pudo abrir el turno.");
        return;
      }
      turno = { ...data.turno, abierto: true };
      paintTurno();
      buscar.focus();
    } catch (error) {
      showTurnoError("No hay conexión con el servidor.");
    }
  });

  document.getElementById("mostrar-cierre").addEventListener("click", async () => {
    showTurnoError("");
    if (items.length) {
      showTurnoError("Cobra o espera el ticket actual antes de cerrar el turno.");
      return;
    }
    try {
      const res = await fetch("/api/turno");
      const data = await res.json();
      if (!data.turno) {
        turno = { abierto: false };
        paintTurno();
        return;
      }
      turno = { ...data.turno, abierto: true };
      paintTurno();
      cerrarForm.classList.remove("hidden");
      paintDiferencia();
      contadoEl.focus();
    } catch (error) {
      showTurnoError("No hay conexión con el servidor.");
    }
  });

  function paintDiferencia() {
    const el = document.getElementById("turno-diferencia");
    const contado = Number(contadoEl.value);
    if (!Number.isFinite(contado)) {
      el.textContent = "—";
      el.className = "";
      return;
    }
    const diff = round2(contado - Number(turno.esperado || 0));
    el.textContent = fmt(diff);
    el.className = diff < 0 ? "diff-neg" : diff > 0 ? "diff-pos" : "";
  }

  contadoEl.addEventListener("input", paintDiferencia);

  cerrarForm.addEventListener("submit", async (e) => {
    e.preventDefault();
    showTurnoError("");
    if (items.length) {
      showTurnoError("Cobra o espera el ticket actual antes de cerrar el turno.");
      return;
    }
    try {
      const res = await fetch("/api/turno/cerrar", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ contado: Number(contadoEl.value) })
      });
      const data = await res.json();
      if (!res.ok) {
        showTurnoError(data.error || "No se pudo cerrar el turno.");
        return;
      }
      const cierre = data.cierre;
      turno = { abierto: false };
      contadoEl.value = "";
      paintTurno();
      showTurnoOk(
        `Turno cerrado. Esperado ${fmt(cierre.esperado)}, contado ${fmt(cierre.contado)}, diferencia ${fmt(cierre.diferencia)}.`
      );
    } catch (error) {
      showTurnoError("No hay conexión con el servidor.");
    }
  });

  paintTurno();
  render();
  buscar.focus();
})();
