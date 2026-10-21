# MercadoOS — Avance del proyecto

**Sistema de gestión para supermercados**  
Proyecto final de Programación  
Estudiante: Ángel  
Fecha: 21 de septiembre de 2026

---

## 1. Nombre y problema

Los supermercados y abarrotes pequeños suelen operar con cuadernos, Excel o memoria. Eso provoca:

- Stock incorrecto (se vende lo que ya no hay, o se caduca sin darse cuenta).
- Caja sin control (no se sabe cuánto debió haber al cierre).
- Precios inconsistentes entre cajeros.
- Cero reportes útiles para decidir qué comprar.

**MercadoOS** es un sistema web de punto de venta + inventario + reportes, pensado primero para la operación diaria y después para venderse a negocios reales.

## 2. Objetivo

Construir un sistema que permita:

1. Autenticar empleados con roles.
2. Mantener el catálogo de productos (código de barras, precio, impuesto, stock).
3. Vender en caja y **descontar stock en el mismo momento**.
4. Consultar historial de ventas y reportes básicos.
5. Dejar documentada la evolución a compras, cierre de caja y multi-sucursal.

## 3. Alcance

| Fase | Para qué | Estado |
|------|----------|--------|
| **Fase 1 — MVP de clase** | Login, productos, inventario, caja, ventas, reportes | Prototipo funcionando |
| **Fase 2 — Sistema completo** | Proveedores, compras, clientes, cierre de caja, devoluciones, caducidad | Diseño (siguiente ciclo) |
| **Fase 3 — Producto vendible** | Multi-sucursal, tickets fiscales, auditoría, backup, instalador | Roadmap comercial |

Mañana se presenta **análisis + diseño + prototipo Fase 1**. No se promete aún el producto comercial completo.

## 4. Módulos

### Fase 1 (Must) — núcleo del curso

- **Usuarios y roles:** login, contraseñas con hash, roles Admin / Cajero / Bodeguero / Gerente.
- **Catálogo:** código de barras, nombre, categoría, unidad, precio, costo, ISV, stock mínimo.
- **Inventario:** existencias reales, kardex (movimientos), alerta de stock bajo, no vender sin stock.
- **Punto de venta:** búsqueda por código o nombre, carrito, descuento, efectivo/tarjeta, cambio, ticket, descuento automático de stock.
- **Historial de ventas:** detalle del día, anulación solo admin.
- **Reportes:** ventas del día/semana, más vendidos, stock bajo, total por cajero.

### Fase 2 (Should) — lo que lo hace “de supermercado”

- Proveedores y órdenes de compra (el stock sube al recibir, no “editando a mano”).
- Clientes (RTN/DNI, historial).
- Apertura y cierre de caja (fondo, esperado vs real).
- Devoluciones con motivo y reingreso de stock.
- Promociones (2x1, descuento por categoría).
- Lotes y caducidad.
- Dashboard gerencial (margen, productos muertos, horas pico).

### Fase 3 (Later) — para venderlo

- Multi-sucursal y multi-caja.
- Impresión de factura fiscal.
- Auditoría (quién cambió un precio o un stock).
- Backup y exportación Excel/PDF.
- Permisos granulares.
- Configuración del negocio (impuesto, moneda, logo).
- Despliegue / instalador.

## 5. Roles

| Rol | Puede hacer |
|-----|-------------|
| **Cajero** | Vender, consultar precio/stock, cobrar, ver sus ventas |
| **Bodeguero** | Productos, ajustes de inventario, ver caducidad |
| **Gerente** | Reportes, precios, ventas, dashboard, clientes |
| **Administrador** | Usuarios, configuración, anulaciones, todo lo anterior |

## 6. Flujo de negocio

```
Proveedor → Compras → Inventario → Caja → Ventas → Reportes
                              ↑
                          Clientes / Cajeros
```

El sistema no es un CRUD de productos: es el ciclo **compra → stock → venta → reporte**.

## 7. Modelo de datos (mínimo)

Entidades: `Rol`, `Usuario`, `Categoria`, `Producto`, `Venta`, `DetalleVenta`, `MovimientoInventario`.

A futuro: `Proveedor`, `Compra`, `DetalleCompra`, `Cliente`, `Caja`, `CierreCaja`, `Promocion`, `Lote`.

Relaciones clave:

- Un usuario registra muchas ventas.
- Una venta tiene muchos detalles.
- Cada detalle apunta a un producto.
- Cada venta/ajuste genera un movimiento de inventario (kardex).

## 8. Stack tecnológico

Decisión para el prototipo (el curso no impuso lenguaje; Python no está instalado en este equipo):

| Capa | Tecnología | Por qué |
|------------------|---------|
| Lenguaje | **Node.js 20** | Disponible, web, fácil de mostrar |
| Backend | **Express** | MVC simple, estándar de clase |
| Vistas | **EJS + HTML/CSS/JS** | El profesor ve el flujo request → vista |
| Base de datos | **SQLite** (sql.js) | Cero instalación; se puede migrar a MySQL/PostgreSQL |
| Auth | **express-session + bcryptjs** | Contraseñas hasheadas, nunca en texto plano |
| Moneda / impuesto | Configurable | ISV 15% por producto |

Camino de mejora comercial: PostgreSQL o MySQL, facturación, Docker.

## 9. Casos de uso (demo)

1. Iniciar sesión según rol.
2. Registrar / editar un producto.
3. Vender en caja (código de barras → carrito → cobro → stock baja).
4. Rechazar venta si no hay existencias.
5. Ver alerta de stock bajo.
6. Consultar ventas del día y reporte por cajero.
7. (Admin) crear un usuario nuevo.

## 10. Cronograma

| Semana | Entrega |
|--------|---------|
| **Semana 1 (ahora)** | Análisis, módulos, prototipo: login + productos + caja |
| Semana 2 | Inventario (kardex), historial, pulido de caja y ticket |
| Semana 3 | Un extra de Fase 2: compras **o** cierre de caja |
| Semana 4 | Reportes, validaciones, README, datos de prueba, defensa |

## 11. Cómo demostrar el avance

1. Abrir las diapositivas: `docs/presentacion.html`
2. Levantar el prototipo:

```bash
npm install
npm start
```

3. Entrar a `http://localhost:3000`

Cuentas de prueba:

| Usuario | Contraseña | Rol |
|---------|------------|-----|
| `admin` | `admin123` | Administrador |
| `cajero` | `cajero123` | Cajero |
| `bodeguero` | `bodeguero123` | Bodeguero |
| `gerente` | `gerente123` | Gerente |

## 12. Criterio de “completo”

- **Para la nota:** roles, productos, inventario real, POS, reportes, validaciones, datos de prueba, README.
- **Para venderlo después:** compras, cierre de caja, caducidad, tickets fiscales, auditoría, multi-sucursal, instalación fácil.
