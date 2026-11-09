(() => {
  const input = document.getElementById("ajuste-buscar");
  const hidden = document.getElementById("ajuste-id");
  const resultados = document.getElementById("ajuste-resultados");
  const elegido = document.getElementById("ajuste-elegido");
  const form = document.getElementById("ajuste-form");
  if (!input || !hidden || !resultados || !form) return;

  const productos = Array.isArray(window.PRODUCTOS_AJUSTE) ? window.PRODUCTOS_AJUSTE : [];
  const esc = (value) =>
    String(value ?? "").replace(/[&<>"']/g, (ch) => ({
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    })[ch]);

  function stockText(prod) {
    return `Hay ${Number(prod.stock).toFixed(2)} ${prod.unidad || ""}`.trim();
  }

  function render(q) {
    const query = q.trim().toLowerCase();
    hidden.value = "";
    elegido.textContent = "";
    if (!query) {
      resultados.innerHTML = "";
      return;
    }
    const matches = productos
      .filter((p) => {
        const code = String(p.codigo || p.codigo_barras || "");
        return p.nombre.toLowerCase().includes(query) || code.toLowerCase().includes(query);
      })
      .slice(0, 8);
    resultados.innerHTML = matches.length
      ? matches
          .map(
            (p) => `<button type="button" class="result" data-id="${p.id}">
              <span>${esc(p.nombre)}<br><small>${esc(p.codigo || p.codigo_barras)} · ${esc(stockText(p))}</small></span>
            </button>`
          )
          .join("")
      : `<p class="muted">No hay un producto con “${esc(q)}”.</p>`;
    resultados.querySelectorAll(".result").forEach((btn) => {
      btn.addEventListener("click", () => choose(productos.find((p) => String(p.id) === btn.dataset.id)));
    });
  }

  function choose(prod) {
    if (!prod) return;
    hidden.value = String(prod.id);
    input.value = prod.nombre;
    resultados.innerHTML = "";
    elegido.textContent = `Seleccionado: ${prod.nombre}. ${stockText(prod)}.`;
  }

  input.addEventListener("input", () => render(input.value));

  form.addEventListener("submit", (e) => {
    if (hidden.value) return;
    const query = input.value.trim().toLowerCase();
    const exact = productos.filter(
      (p) => p.nombre.toLowerCase() === query || String(p.codigo || p.codigo_barras || "").toLowerCase() === query
    );
    if (exact.length === 1) {
      hidden.value = String(exact[0].id);
      return;
    }
    e.preventDefault();
    elegido.textContent = "Elige un producto de la lista.";
  });
})();
