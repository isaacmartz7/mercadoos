# MercadoOS

Sistema web de **punto de venta, inventario y reportes** para supermercados. Proyecto final de programación con camino a producto vendible.

## Stack

| Capa | Tecnología |
|------|------------|
| Runtime | Node.js 20+ |
| Backend | Express (MVC) |
| Vistas | EJS + HTML/CSS/JS |
| Base de datos | SQLite (archivo local, sin instalar servidor) |
| Auth | Sesiones + bcrypt |

## Cómo correrlo

```bash
npm install
npm start
```

Abre [http://localhost:3000](http://localhost:3000)

## Cuentas de demostración

| Usuario | Contraseña | Rol |
|---------|------------|-----|
| admin | admin123 | Administrador |
| cajero | cajero123 | Cajero |
| bodeguero | bodeguero123 | Bodeguero |
| gerente | gerente123 | Gerente |

## Avance para la clase

- Diapositivas: abre [http://localhost:3000/presentacion](http://localhost:3000/presentacion) o el archivo `docs/presentacion.html`
- Documento: `docs/AVANCE.md`

## Módulos del prototipo (Fase 1)

- Login con roles
- Catálogo de productos (código de barras, precio, ISV, stock)
- Caja: venta que **descuenta stock**
- Historial de ventas
- Reportes (día, más vendidos, stock bajo, por cajero)
- Kardex de inventario
- Usuarios (solo admin)
