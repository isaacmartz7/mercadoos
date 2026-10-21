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
  let items = [];

  const fmt = (n) => `${moneda} ${Number(n).toFixed(2)}`;

  function showError(msg) {
    errorEl.textContent = msg || "";
    errorEl.classList.toggle("hidden", !msg);
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
    const total = Math.max(0, subtotal + impuesto - descuento);
    return { subtotal, impuesto, descuento, total };
  }

  function render() {
    carritoEl.innerHTML = items.length
      ? items
          .map(
            (it, i) => `<li>
              <span>${it.nombre}<br><small>${fmt(it.precio_venta)} · stock ${it.stock}</small></span>
              <input type="number" min="0.01" step="0.01" value="${it.cantidad}" data-i="${i}" />
              <button type="button" data-del="${i}">x</button>
            </li>`
          )
          .join("")
      : "<li class='muted'>Vacío. Busca un producto.</li>";
    const t = totals();
    document.getElementById("subtotal").textContent = fmt(t.subtotal);
    document.getElementById("impuesto").textContent = fmt(t.impuesto);
    document.getElementById("total").textContent = fmt(t.total);
    const recibido = Number(recibidoEl.value) || 0;
    const cambio = metodoEl.value === "efectivo" ? Math.max(0, recibido - t.total) : 0;
    document.getElementById("cambio").textContent = fmt(cambio);
    wrapRecibido.style.opacity = metodoEl.value === "efectivo" ? "1" : "0.4";
  }

  function add(prod) {
    const found = items.find((it) => it.id === prod.id);
    const nextQty = found ? found.cantidad + 1 : 1;
    if (nextQty > prod.stock) {
      showError(`Stock insuficiente de ${prod.nombre}. Hay ${prod.stock}.`);
      return;
    }
    showError("");
    if (found) found.cantidad = nextQty;
    else items.push({ ...prod, cantidad: 1 });
    render();
  }

  async function search(q) {
    const res = await fetch(`/api/productos?q=${encodeURIComponent(q)}`);
    const data = await res.json();
    if (data.length === 1 && data[0].codigo_barras === q) {
      add(data[0]);
      resultados.innerHTML = "";
      buscar.value = "";
      return;
    }
    resultados.innerHTML = data.length
      ? data
          .map(
            (p) => `<button type="button" class="result" data-id="${p.id}">
              <span>${p.nombre}<br><small>${p.codigo_barras}</small></span>
              <strong>${fmt(p.precio_venta)}</strong>
            </button>`
          )
          .join("")
      : "<p class='muted'>Sin resultados.</p>";
    resultados.querySelectorAll(".result").forEach((btn) => {
      btn.addEventListener("click", () => {
        add(data.find((p) => String(p.id) === btn.dataset.id));
        resultados.innerHTML = "";
        buscar.value = "";
        buscar.focus();
      });
    });
  }

  document.getElementById("buscar-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const q = buscar.value.trim();
    if (q) search(q);
  });

  carritoEl.addEventListener("input", (e) => {
    const i = e.target.dataset.i;
    if (i == null) return;
    const qty = Number(e.target.value);
    if (qty > items[i].stock) {
      showError(`Stock insuficiente. Hay ${items[i].stock}.`);
      e.target.value = items[i].cantidad;
      return;
    }
    items[i].cantidad = qty > 0 ? qty : items[i].cantidad;
    render();
  });
  carritoEl.addEventListener("click", (e) => {
    if (e.target.dataset.del == null) return;
    items.splice(Number(e.target.dataset.del), 1);
    render();
  });
  [descuentoEl, recibidoEl, metodoEl].forEach((el) => el.addEventListener("input", render));
  metodoEl.addEventListener("change", render);

  const cobrarBtn = document.getElementById("cobrar");
  cobrarBtn.addEventListener("click", async () => {
    const t = totals();
    if (!items.length) return showError("Agrega productos al ticket.");
    if (cobrarBtn.disabled) return;
    cobrarBtn.disabled = true;
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
        cobrarBtn.disabled = false;
        return;
      }
      window.location.href = `/ventas/${data.ventaId}`;
    } catch (error) {
      showError("No hay conexión con el servidor.");
      cobrarBtn.disabled = false;
    }
  });

  render();
})();
