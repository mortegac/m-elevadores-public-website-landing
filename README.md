# Landings M-Elevadores

Tres landings para campañas de Google Ads. La interfaz usa HTML y CSS; Google Tag Manager es el único script del lado del navegador. Un servidor Node.js recibe los formularios y los envía a la API de cotizaciones existente.

## Ejecución

Requiere Node.js 20 o superior. No hay dependencias para instalar.

```sh
node server.js
node --test
```

Abrir `http://localhost:3000`. Las rutas públicas son:

- `/accesibilidad-residencial-elevadores`
- `/instalacion-ascensores-montacargas`
- `/mantencion-reparacion-ascensores`

El servidor usa por defecto `https://www.melevadores.cl/api/cotizacion`. **Un envío local con datos válidos llega al servicio real**; las pruebas automatizadas usan un servicio simulado.

## Preparación para producción

El proveedor de alojamiento está pendiente. Debe ejecutar un servidor Node.js persistente y redirigirle el tráfico HTTPS del subdominio. Configurar `PORT`, `PUBLIC_BASE_URL=https://landing.melevadores.cl` y `FORM_CONFIRMATION_SECRET`, un secreto aleatorio compartido entre instancias. En desarrollo, cuando no se define el secreto, se genera uno temporal al iniciar el proceso. Ver `.env.example`; las variables deben configurarse en el entorno del proceso, no se cargan automáticamente desde ese archivo.

El subdominio también necesita la configuración DNS y TLS del proveedor elegido. La cuenta de Google Tag Manager debe permitir el nuevo dominio y conservar sus activadores de conversiones. Confirmar con el servicio receptor la clasificación del campo `origen` antes de modificar los valores usados por el sitio actual.
