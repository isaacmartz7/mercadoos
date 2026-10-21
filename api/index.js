const { createApp } = require("../src/server");

let appPromise = null;

module.exports = async (req, res) => {
  try {
    if (!appPromise) {
      appPromise = createApp();
    }
    const app = await appPromise;
    return app(req, res);
  } catch (err) {
    console.error("Vercel Function Error:", err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "text/html; charset=utf-8");
    res.end(`
      <div style="font-family: sans-serif; padding: 2rem;">
        <h2>Error al iniciar MercadoOS en Vercel</h2>
        <p>${err.message || err}</p>
        <pre style="background: #f4f4f5; padding: 1rem; border-radius: 8px; overflow: auto;">${err.stack || ""}</pre>
      </div>
    `);
  }
};
