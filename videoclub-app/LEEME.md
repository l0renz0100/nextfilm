# Nextfilm — app para tu LG

App tipo "videoclub" que lee las películas de tu disco USB, les pone carátula
automáticamente y las reproduce, todo dentro de la propia tele.

**Importante:** las apps instaladas por Developer Mode en una LG no tienen
permiso para leer el USB directamente (webOS TV no expone ningún servicio
para eso a apps normales). Por eso la lectura del USB no la hace la tele,
sino un pequeño servidor (`server/server.js`) que corre en tu PC — el mismo
PC donde tienes el disco conectado — y que sirve la lista de películas y el
vídeo por tu red local. La tele solo hace peticiones HTTP normales a ese
servidor, así que tiene que estar encendido y con el servidor arrancado
cada vez que quieras ver algo.

## Cómo está organizado el disco

La app espera esta estructura de carpetas (una carpeta por película):

```
/Inception (2010)/Inception.mp4
/Coco (2017)/Coco.mkv
```

- El nombre de la carpeta = título + año entre paréntesis. Si no pones año,
  usa solo el título tal cual.
- Si metes un archivo `poster.jpg` (o `cover.jpg` / `folder.jpg`) dentro de la
  carpeta de la película, la app usa esa imagen directamente, sin llamar a
  ninguna API externa.

## 1. Previsualizar en el PC

Abre `index.html` haciendo doble clic (se abre en tu navegador normal).
Como el navegador no tiene acceso a la API de la tele, la app detecta que no
está en la LG y carga 6 películas de ejemplo, para que veas el diseño, el
carrusel y las animaciones funcionando.

Truco: si le metes tu clave de TMDb en el botón de ajustes (⚙, arriba a la
derecha) mientras la ves en el PC, también puedes comprobar cómo quedan las
carátulas reales antes de instalarla en la tele.

### Conseguir la clave de TMDb (gratis, 2 minutos)
1. Crea una cuenta en https://www.themoviedb.org
2. Ve a tu perfil → Ajustes → API → solicita una clave de tipo "Developer".
3. Pégala en el botón ⚙ de la app (tanto en el PC como luego en la tele).

Sin clave, la app funciona igual, pero genera una carátula sencilla con el
título en vez de traer el póster real.

## 2. Empaquetar la app como .ipk

Necesitas la herramienta oficial de LG, `ares-package` (parte de `ares-cli`).
Se instala con Node.js, que ya tienes:

```bash
npm install -g @webosose/ares-cli
```

Luego, desde la carpeta que contiene a `videoclub-app`:

```bash
ares-package videoclub-app
```

Esto genera un archivo `com.penna.videoclub_1.0.0_all.ipk` en la misma carpeta.

## 3. Instalar en la LG

Con el **webOS Dev Manager** que ya tienes configurado y emparejado con tu tele:

1. Abre webOS Dev Manager.
2. Ve al apartado de **Apps**.
3. Busca la opción de **instalar / sideload** y selecciona el archivo `.ipk`
   que has generado en el paso anterior.
4. Espera a que termine — te aparecerá un icono nuevo llamado **"Nextfilm"**
   en el menú de apps de la tele (dentro de las apps instaladas manualmente).

## 4. Arrancar el servidor en tu PC

Con el disco USB conectado **al PC** (no a la tele):

```bash
node server/server.js "D:\ruta\a\tu\USB"
```

La consola te imprimirá una o varias direcciones tipo `http://192.168.1.50:8080`
— esa es la que tienes que poner en la tele (paso siguiente). Déjalo abierto
mientras uses la app.

Si no quieres escribir la IP cada vez en la tele, puedes dejarla fija
directamente en el código: abre `js/app.js` y pon tu dirección en
`CONFIG.SERVER_URL` (al principio del archivo).

## 5. Usarla

- Con el disco conectado al PC y el servidor arrancado, abre la app
  "Nextfilm" en la tele.
- Si no pusiste la dirección en `CONFIG.SERVER_URL`, ve a ⚙ (arriba a la
  derecha) y pégala en "Dirección del servidor de películas" — el teclado en
  pantalla de la LG aparece al pulsar OK sobre el campo.
- Con el mando: **◀ ▶** para moverte entre carátulas, **OK** para reproducir,
  **Atrás** para volver al videoclub desde una película.
- Si añades o quitas películas de la carpeta mientras la app está abierta, se
  actualiza sola en unos segundos (sin tener que reiniciar nada).

## Si la reproducción del vídeo no arranca

El `<video>` de la app reproduce directamente la URL que le da el servidor
(`http://tu-pc:puerto/video/...`). Si el carrusel y las carátulas se ven bien
pero el vídeo no arranca al pulsar OK, puede ser el formato del archivo (el
navegador de la LG no reproduce cualquier códec/contenedor, aunque el PC sí lo
haga) — dímelo con el formato de tus vídeos y lo revisamos.
