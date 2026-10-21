module.exports = {
  port: process.env.PORT || 3000,
  sessionSecret: process.env.SESSION_SECRET || "mercadoos-clase-cambiar-en-produccion",
  negocio: {
    nombre: "MercadoOS",
    sucursal: "Tienda demo",
    moneda: "L",
    impuestoDefault: 0.15
  }
};
