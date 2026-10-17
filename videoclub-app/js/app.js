/* ============================================================
   VIDEOCLUB — lógica de la app
   - En la LG: las apps de Developer Mode no pueden leer el USB
     directamente (webOS TV no expone ningún servicio para ello
     a apps normales). En su lugar, la app pide la lista de
     películas y el vídeo a un pequeño servidor (server/server.js)
     que corre en tu PC y sí tiene acceso completo al USB.
   - En el PC (navegador normal): usa una colección de ejemplo
     para que puedas ver y ajustar el diseño antes de instalarla.
   ============================================================ */

const CONFIG = {
  // Pega aquí tu API Key (v3 auth) de themoviedb.org.
  // Con esto puesto, la app no te pedirá nada por pantalla:
  // arranca directamente trayendo las carátulas reales.
  TMDB_API_KEY: 'a05d781482f8465ebdbf69ed5fb6c5a5',

  // Dirección del servidor (server/server.js) que corre en tu PC,
  // p.ej. 'http://192.168.1.50:8080'. Ponla aquí para no tener que
  // escribirla cada vez en Ajustes — el campo de Ajustes, si lo
  // rellenas, tiene prioridad sobre este valor.
  SERVER_URL: 'http://192.168.1.111:8080',

  // Si pones algo aquí, el modo "sin servidor" (PC, sin ?server=1 ni tele)
  // pedirá esta contraseña una vez por navegador antes de mostrar la app —
  // pensado para cuando la publiques en un sitio público (Netlify y demás),
  // así no la puede usar cualquiera que encuentre la URL. Déjalo vacío para
  // no pedir nada (como hasta ahora). No afecta a la tele.
  SITE_PASSWORD: 'Ichigo',
};

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm'];
const POSTER_FILENAMES = ['poster.jpg', 'poster.png', 'cover.jpg', 'folder.jpg'];

// El segundo caso (?server=1) es solo para poder probar desde el navegador
// del PC el mismo camino que usará la tele, sin tener que instalar el .ipk.
const isRealDevice = typeof WebOSServiceBridge !== 'undefined'
  || new URLSearchParams(location.search).has('server');
const supportsFolderPicker = 'showDirectoryPicker' in window;

// En la tele quitamos la animación del cambio de fondo del hero (ver
// .no-hero-transition en css/style.css) — en el PC se deja como está.
if (isRealDevice) document.body.classList.add('no-hero-transition');

const state = {
  movies: [],
  series: [],
  seriesLoaded: false,
  catalog: 'movies', // 'movies' | 'series' — qué biblioteca se muestra/busca
  currentIndex: 0,
  mode: 'loading', // loading | empty | error | browse | player
  query: '',
  focusZone: 'carousel', // carousel | nav — a qué responde el mando en la pantalla principal
  navIndex: 0,
  nowPlayingEpisode: null, // { showId, seasonNumber, episodeNumber } mientras se reproduce un episodio
};

function visibleItems() {
  const list = state.catalog === 'series' ? state.series : state.movies;
  if (!state.query) return list;
  const q = state.query.toLowerCase();
  return list.filter(m => m.title.toLowerCase().includes(q));
}

// ---------- Utilidades de UI ----------

function showView(name) {
  document.querySelectorAll('.view').forEach(el => el.hidden = true);
  document.getElementById('view-' + name).hidden = false;
  state.mode = name;
}

function setStatus(errorText) {
  document.getElementById('errorDetail').textContent = errorText || 'Error desconocido.';
}

// ---------- Escaneo vía servidor (server/server.js en tu PC) ----------

function getServerUrl() {
  const url = localStorage.getItem('server_url') || CONFIG.SERVER_URL || '';
  return url.trim().replace(/\/+$/, '');
}

async function scanServerForMovies() {
  const base = getServerUrl();
  if (!base) return { movies: [], noServer: true };

  const res = await fetch(base + '/api/movies');
  if (!res.ok) throw new Error('El servidor respondió con un error (' + res.status + ').');
  const data = await res.json();

  const movies = (data.movies || []).map(m => ({
    id: m.id, title: m.title, year: m.year,
    filePath: m.videoUrl,
    serverPosterUrl: m.posterUrl || null,
    serverBackdropUrl: m.backdropUrl || null,
    serverOverview: m.overview || '',
    serverRating: m.rating,
    serverRuntime: m.runtime || null,
    serverDirector: m.director || '',
    serverCast: m.cast || [],
    localPosterPath: null, driveId: 'server',
    poster: null, backdrop: null, overview: '', rating: null,
  }));
  return { movies, noServer: false };
}

async function scanServerForSeries() {
  const base = getServerUrl();
  if (!base) return { series: [], noServer: true };

  const res = await fetch(base + '/api/series');
  if (!res.ok) throw new Error('El servidor respondió con un error (' + res.status + ').');
  const data = await res.json();

  const series = (data.series || []).map(s => ({
    id: s.id, title: s.title, year: s.year,
    seasons: s.seasons,
    serverPosterUrl: s.posterUrl || null,
    serverBackdropUrl: s.backdropUrl || null,
    serverOverview: s.overview || '',
    serverRating: s.rating,
    serverCreator: s.creator || '',
    serverCast: s.cast || [],
    driveId: 'server',
    poster: null, backdrop: null, overview: '', rating: null, creator: '', cast: [],
  }));
  return { series, noServer: false };
}

function parseTitleYear(folderName) {
  const match = folderName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) return { title: match[1].trim(), year: match[2] };
  return { title: folderName.trim(), year: null };
}

function isVideoFile(name) {
  const lower = name.toLowerCase();
  return VIDEO_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// ---------- Probar con una carpeta real del PC (Chrome / Edge) ----------
// Usa la misma convención que el USB: una carpeta por película,
// "Título (Año)/video.ext", con un poster.jpg opcional dentro.
//
// El navegador no deja "poner una ruta" en el código para esto — por
// seguridad, showDirectoryPicker() siempre exige que el usuario la elija a
// mano, aunque sea la misma cada vez. Lo que sí podemos hacer es recordar el
// permiso ya concedido (en IndexedDB) para que la próxima vez que abras la
// app no haga falta volver a elegirla.

function openHandleDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('nextfilm', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('handles');
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function saveFolderHandle(handle) {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readwrite');
    tx.objectStore('handles').put(handle, 'usbFolder');
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
  });
}

async function loadSavedFolderHandle() {
  const db = await openHandleDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction('handles', 'readonly');
    const req = tx.objectStore('handles').get('usbFolder');
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

// Busca dentro de rootHandle una subcarpeta con ese nombre, sin distinguir
// mayúsculas ni acentos (mismo criterio que findSubfolder() en server.js).
async function findLocalSubfolder(rootHandle, name) {
  const normalize = s => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const target = normalize(name);
  for await (const [childName, childHandle] of rootHandle.entries()) {
    if (childHandle.kind === 'directory' && normalize(childName) === target) return childHandle;
  }
  return null;
}

async function scanLocalMovies(peliculasHandle) {
  const movies = [];
  for await (const [name, handle] of peliculasHandle.entries()) {
    if (handle.kind !== 'directory') continue;

    let videoHandle = null;
    let posterHandle = null;
    for await (const [childName, childHandle] of handle.entries()) {
      if (childHandle.kind !== 'file') continue;
      if (isVideoFile(childName)) videoHandle = childHandle;
      else if (POSTER_FILENAMES.includes(childName.toLowerCase())) posterHandle = childHandle;
    }
    if (!videoHandle) continue;

    const { title, year } = parseTitleYear(name);
    movies.push({
      id: name, title, year,
      localFileHandle: videoHandle,
      localPosterHandle: posterHandle,
      localPosterPath: null, filePath: null, driveId: 'pc',
      poster: null, backdrop: null, overview: '', rating: null,
    });
  }
  return movies;
}

// Misma convención que el servidor: Nombre de la Serie (Año)/Temporada NN/vídeo.ext.
// El número de episodio es el orden alfabético de los vídeos dentro de cada temporada.
async function scanLocalSeries(seriesHandle) {
  const shows = [];
  for await (const [showName, showHandle] of seriesHandle.entries()) {
    if (showHandle.kind !== 'directory') continue;

    let posterHandle = null;
    const seasonHandles = [];
    for await (const [childName, childHandle] of showHandle.entries()) {
      if (childHandle.kind === 'directory') seasonHandles.push({ name: childName, handle: childHandle });
      else if (POSTER_FILENAMES.includes(childName.toLowerCase())) posterHandle = childHandle;
    }
    seasonHandles.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const seasons = [];
    for (let i = 0; i < seasonHandles.length; i++) {
      const { name: seasonName, handle: seasonHandle } = seasonHandles[i];

      // Una carpeta por episodio dentro de la temporada (misma idea que la
      // carpeta de cada película): el nombre de la carpeta da el orden, y
      // dentro se busca el archivo de vídeo, se llame como se llame.
      const episodeFolders = [];
      for await (const [childName, childHandle] of seasonHandle.entries()) {
        if (childHandle.kind === 'directory') episodeFolders.push({ name: childName, handle: childHandle });
      }
      episodeFolders.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const episodes = [];
      for (const folder of episodeFolders) {
        let videoHandle = null;
        for await (const [fileName, fileHandle] of folder.handle.entries()) {
          if (fileHandle.kind === 'file' && isVideoFile(fileName)) { videoHandle = fileHandle; break; }
        }
        if (!videoHandle) continue;
        episodes.push({ episodeNumber: episodes.length + 1, localFileHandle: videoHandle, title: null, runtime: null });
      }
      if (!episodes.length) continue;

      const match = seasonName.match(/(\d+)/);
      const seasonNumber = match ? parseInt(match[1], 10) : i + 1;
      seasons.push({ seasonNumber, episodes });
    }
    if (!seasons.length) continue;

    const { title, year } = parseTitleYear(showName);
    shows.push({
      id: showName, title, year, seasons,
      localPosterHandle: posterHandle,
      driveId: 'pc',
      poster: null, backdrop: null, overview: '', rating: null, creator: '', cast: [],
    });
  }
  return shows;
}

// Punto de entrada del selector de carpeta del PC: la carpeta elegida debe
// contener "Peliculas" y "Series" — cada una se escanea con su convención.
async function scanLocalFolder(rootHandle) {
  const peliculasHandle = await findLocalSubfolder(rootHandle, 'peliculas');
  const seriesHandle = await findLocalSubfolder(rootHandle, 'series');
  const movies = peliculasHandle ? await scanLocalMovies(peliculasHandle) : [];
  const series = seriesHandle ? await scanLocalSeries(seriesHandle) : [];
  return { movies, series };
}

// ---------- Datos de ejemplo para previsualizar en el PC ----------

function mockMovies() {
  const samples = [
    { title: 'Interestelar', year: '2014' },
    { title: 'El Padrino', year: '1972' },
    { title: 'Amélie', year: '2001' },
    { title: 'Parásitos', year: '2019' },
    { title: 'Coco', year: '2017' },
    { title: 'Matrix', year: '1999' },
    { title: 'El Señor de los Anillos: La Comunidad del Anillo', year: '2001' },
    { title: 'Pulp Fiction', year: '1994' },
    { title: 'Spider-Man: Un nuevo universo', year: '2018' },
    { title: 'Whiplash', year: '2014' },
    { title: 'Your Name', year: '2016' },
    { title: 'Oppenheimer', year: '2023' },
  ];
  return samples.map(s => ({
    id: s.title, title: s.title, year: s.year,
    filePath: '/demo/' + s.title + '.mp4',
    localPosterPath: null, driveId: 'demo',
    poster: null, overview: '', rating: null,
  }));
}

// ---------- Carátulas (TMDb con fallback generado) ----------

function hashHue(str) {
  let h = 0;
  for (let i = 0; i < str.length; i++) h = (h * 31 + str.charCodeAt(i)) % 360;
  return h;
}

function generatePlaceholderPoster(title) {
  const hue = hashHue(title);
  const lines = wrapText(title, 14);
  const textSvg = lines.map((line, i) =>
    `<text x="50%" y="${58 + i * 9}%" text-anchor="middle" font-family="Arial, sans-serif" font-size="7.5%" fill="#F1ECFB" font-weight="700">${escapeXml(line)}</text>`
  ).join('');
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="600">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue},60%,22%)"/>
        <stop offset="100%" stop-color="hsl(${(hue + 40) % 360},55%,10%)"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <rect x="6%" y="6%" width="88%" height="88%" fill="none" stroke="rgba(255,255,255,.25)" stroke-width="2"/>
    ${textSvg}
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

function wrapText(text, maxChars) {
  const words = text.split(' ');
  const lines = [];
  let current = '';
  words.forEach(w => {
    if ((current + ' ' + w).trim().length > maxChars) {
      lines.push(current.trim());
      current = w;
    } else {
      current = (current + ' ' + w).trim();
    }
  });
  if (current) lines.push(current);
  return lines.slice(0, 3);
}

function escapeXml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function generatePlaceholderBackdrop(title) {
  const hue = hashHue(title);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="720">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue},45%,14%)"/>
        <stop offset="100%" stop-color="#141414"/>
      </linearGradient>
    </defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
  </svg>`;
  return 'data:image/svg+xml;base64,' + btoa(unescape(encodeURIComponent(svg)));
}

async function resolvePoster(movie) {
  if (movie.localPosterHandle) {
    const file = await movie.localPosterHandle.getFile();
    const url = URL.createObjectURL(file);
    movie.poster = url;
    movie.backdrop = url;
    return;
  }
  if (movie.driveId === 'server') {
    // El servidor (server/server.js) ya resolvió todo esto una vez con TMDb
    // y lo tiene cacheado en disco — la tele no vuelve a llamar a TMDb.
    movie.poster = movie.serverPosterUrl || generatePlaceholderPoster(movie.title);
    movie.backdrop = movie.serverBackdropUrl || movie.poster;
    movie.overview = movie.serverOverview || '';
    movie.rating = movie.serverRating;
    movie.runtime = movie.serverRuntime || null;
    movie.director = movie.serverDirector || '';
    movie.cast = movie.serverCast || [];
    return;
  }
  if (movie.localPosterPath) {
    movie.poster = 'file://' + movie.localPosterPath;
    movie.backdrop = movie.poster;
    return;
  }
  const cacheKey = 'poster_v4_' + movie.title + '_' + movie.year;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      movie.poster = parsed.poster;
      movie.backdrop = parsed.backdrop || parsed.poster;
      movie.overview = parsed.overview || '';
      movie.rating = parsed.rating;
      movie.runtime = parsed.runtime || null;
      movie.director = parsed.director || '';
      movie.cast = parsed.cast || [];
      return;
    } catch (e) { /* cache corrupto, seguimos */ }
  }

  const key = localStorage.getItem('tmdb_key') || CONFIG.TMDB_API_KEY;
  if (key && key !== 'PON_AQUI_TU_API_KEY') {
    try {
      const url = `https://api.themoviedb.org/3/search/movie?api_key=${key}&language=es-ES&query=${encodeURIComponent(movie.title)}${movie.year ? ('&year=' + movie.year) : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      const hit = data.results && data.results[0];
      if (hit && hit.poster_path) {
        movie.poster = 'https://image.tmdb.org/t/p/w500' + hit.poster_path;
        movie.backdrop = hit.backdrop_path ? ('https://image.tmdb.org/t/p/w1280' + hit.backdrop_path) : movie.poster;
        movie.overview = hit.overview || '';
        movie.rating = hit.vote_average;

        try {
          const detailsUrl = `https://api.themoviedb.org/3/movie/${hit.id}?api_key=${key}&language=es-ES&append_to_response=credits`;
          const dr = await fetch(detailsUrl);
          const ddata = await dr.json();
          movie.runtime = ddata.runtime || null; // minutos
          const directorEntry = ((ddata.credits && ddata.credits.crew) || []).find(c => c.job === 'Director');
          movie.director = directorEntry ? directorEntry.name : '';
          movie.cast = ((ddata.credits && ddata.credits.cast) || []).slice(0, 6).map(c => c.name);
        } catch (e) { movie.runtime = null; movie.director = ''; movie.cast = []; }

        localStorage.setItem(cacheKey, JSON.stringify({
          poster: movie.poster, backdrop: movie.backdrop, overview: movie.overview,
          rating: movie.rating, runtime: movie.runtime, director: movie.director, cast: movie.cast,
        }));
        return;
      }
    } catch (e) { /* sin conexión o fallo de API: usamos el fallback */ }
  }
  movie.poster = generatePlaceholderPoster(movie.title);
  movie.backdrop = generatePlaceholderBackdrop(movie.title);
}

// Igual que resolvePoster(), pero para series. En modo servidor ya llega todo
// resuelto (mismo atajo que las películas); en modo carpeta local del PC no
// hay servidor que pre-resuelva TMDb, así que se pide aquí directamente,
// incluyendo el título/duración de cada episodio por temporada.
async function resolveSeriesInfo(show) {
  if (show.localPosterHandle) {
    const file = await show.localPosterHandle.getFile();
    const url = URL.createObjectURL(file);
    show.poster = url;
    show.backdrop = url;
  }

  if (show.driveId === 'server') {
    show.poster = show.serverPosterUrl || generatePlaceholderPoster(show.title);
    show.backdrop = show.serverBackdropUrl || show.poster;
    show.overview = show.serverOverview || '';
    show.rating = show.serverRating;
    show.creator = show.serverCreator || '';
    show.cast = show.serverCast || [];
    return;
  }

  const cacheKey = 'series_v1_' + show.title + '_' + show.year;
  const cached = localStorage.getItem(cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (!show.poster) show.poster = parsed.poster;
      if (!show.backdrop) show.backdrop = parsed.backdrop || parsed.poster;
      show.overview = parsed.overview || '';
      show.rating = parsed.rating;
      show.creator = parsed.creator || '';
      show.cast = parsed.cast || [];
      applyCachedEpisodeMeta(show, parsed.seasons || []);
      return;
    } catch (e) { /* caché corrupta, seguimos */ }
  }

  const key = localStorage.getItem('tmdb_key') || CONFIG.TMDB_API_KEY;
  if (key && key !== 'PON_AQUI_TU_API_KEY') {
    try {
      const url = `https://api.themoviedb.org/3/search/tv?api_key=${key}&language=es-ES&query=${encodeURIComponent(show.title)}${show.year ? ('&first_air_date_year=' + show.year) : ''}`;
      const r = await fetch(url);
      const data = await r.json();
      const hit = data.results && data.results[0];
      if (hit) {
        if (!show.poster && hit.poster_path) show.poster = 'https://image.tmdb.org/t/p/w500' + hit.poster_path;
        if (!show.backdrop) show.backdrop = hit.backdrop_path ? ('https://image.tmdb.org/t/p/w1280' + hit.backdrop_path) : show.poster;
        show.overview = hit.overview || '';
        show.rating = hit.vote_average;

        try {
          const detailsUrl = `https://api.themoviedb.org/3/tv/${hit.id}?api_key=${key}&language=es-ES&append_to_response=credits`;
          const dr = await fetch(detailsUrl);
          const ddata = await dr.json();
          show.creator = ((ddata.created_by || [])[0] || {}).name || '';
          show.cast = ((ddata.credits && ddata.credits.cast) || []).slice(0, 6).map(c => c.name);
        } catch (e) { show.creator = ''; show.cast = []; }

        for (const season of show.seasons) {
          try {
            const seasonUrl = `https://api.themoviedb.org/3/tv/${hit.id}/season/${season.seasonNumber}?api_key=${key}&language=es-ES`;
            const sr = await fetch(seasonUrl);
            const sdata = await sr.json();
            const tmdbEpisodes = sdata.episodes || [];
            season.episodes.forEach(ep => {
              const match = tmdbEpisodes.find(te => te.episode_number === ep.episodeNumber);
              ep.title = (match && match.name) ? match.name : `Episodio ${ep.episodeNumber}`;
              ep.runtime = (match && match.runtime) ? match.runtime : null;
            });
          } catch (e) { season.episodes.forEach(ep => { ep.title = ep.title || `Episodio ${ep.episodeNumber}`; }); }
        }

        localStorage.setItem(cacheKey, JSON.stringify({
          poster: show.poster, backdrop: show.backdrop, overview: show.overview, rating: show.rating,
          creator: show.creator, cast: show.cast,
          seasons: show.seasons.map(s => ({
            seasonNumber: s.seasonNumber,
            episodes: s.episodes.map(e => ({ episodeNumber: e.episodeNumber, title: e.title, runtime: e.runtime })),
          })),
        }));
        return;
      }
    } catch (e) { /* sin conexión o fallo de API: usamos el fallback */ }
  }

  if (!show.poster) show.poster = generatePlaceholderPoster(show.title);
  if (!show.backdrop) show.backdrop = generatePlaceholderBackdrop(show.title);
  show.seasons.forEach(season => season.episodes.forEach(ep => { if (!ep.title) ep.title = `Episodio ${ep.episodeNumber}`; }));
}

function applyCachedEpisodeMeta(show, cachedSeasons) {
  show.seasons.forEach(season => {
    const cachedSeason = cachedSeasons.find(cs => cs.seasonNumber === season.seasonNumber);
    season.episodes.forEach(ep => {
      const cachedEp = cachedSeason && cachedSeason.episodes.find(ce => ce.episodeNumber === ep.episodeNumber);
      ep.title = cachedEp ? cachedEp.title : `Episodio ${ep.episodeNumber}`;
      ep.runtime = cachedEp ? cachedEp.runtime : null;
    });
  });
}

// ---------- Fila de carátulas ----------

const carouselEl = document.getElementById('carousel');
const heroEl = document.getElementById('hero');
const CARD_STEP = 190; // ancho de tarjeta + separación, en px

// Medir carouselEl.parentElement.clientWidth es una lectura de layout: si se
// hace en cada ◀ ▶ obliga al navegador a recalcular el diseño en cada pulsación
// (caro en el procesador de la tele). Lo medimos solo cuando puede haber
// cambiado de verdad (al construir la fila o al redimensionar la ventana).
let carouselWrapWidth = 0;
function measureCarouselWrap() { carouselWrapWidth = carouselEl.parentElement.clientWidth; }

function renderRow() {
  const movies = visibleItems();
  if (state.currentIndex >= movies.length) state.currentIndex = Math.max(0, movies.length - 1);
  carouselEl.innerHTML = '';
  movies.forEach((movie, i) => {
    const el = document.createElement('div');
    el.className = 'card';
    el.style.backgroundImage = `url("${movie.poster}")`;
    el.addEventListener('click', () => {
      if (i === state.currentIndex) activateCurrentItem();
      else { state.currentIndex = i; updateActiveCard(); renderHero(); preloadNeighborBackdrops(); }
    });
    carouselEl.appendChild(el);
  });
  measureCarouselWrap();
  updateActiveCard();
}

// Solo cambia qué tarjeta está marcada como activa y desplaza la fila —
// evita recrear todas las tarjetas (con sus imágenes) en cada ◀ ▶, que era
// lo que hacía lenta la navegación.
function updateActiveCard() {
  const cards = carouselEl.children;
  for (let i = 0; i < cards.length; i++) {
    cards[i].classList.toggle('card--active', i === state.currentIndex);
  }
  const shift = Math.min(0, (carouselWrapWidth / 2) - (state.currentIndex * CARD_STEP) - 90);
  carouselEl.style.transform = `translateX(${shift}px)`;
}

function formatRuntime(minutes) {
  if (!minutes) return '';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h}h ${m}min`;
  if (h) return `${h}h`;
  return `${m}min`;
}

function formatSeasonCount(seasons) {
  const n = seasons ? seasons.length : 0;
  if (!n) return '';
  return n === 1 ? '1 temporada' : `${n} temporadas`;
}

// Botón "Seguir viendo" del hero: a diferencia del de dentro de la ficha de
// una serie (que retoma ESA serie), este busca la última serie en la que
// viste algo, sea cual sea la que tengas seleccionada ahora en el carrusel.
function updateHeroContinueButton() {
  const btn = document.getElementById('heroContinueBtn');
  if (state.catalog !== 'series') { btn.hidden = true; return; }

  const lastShowId = localStorage.getItem('lastWatchedShowId');
  const lastShow = lastShowId && state.series.find(s => s.id === lastShowId);
  const target = lastShow && findContinueWatchingTarget(lastShow);
  if (!target) { btn.hidden = true; return; }

  btn.hidden = false;
  btn.textContent = `Seguir viendo: ${lastShow.title}`;
  btn.onclick = () => playEpisode(lastShow, target.seasonNumber, target.episodeNumber, target.resumeSeconds);
}

function renderHero() {
  const item = visibleItems()[state.currentIndex];
  const playBtnEl = document.getElementById('playBtn');
  updateHeroContinueButton();
  if (!item) {
    heroEl.style.backgroundImage = '';
    document.getElementById('ticketYear').textContent = '—';
    document.getElementById('detTitle').textContent = 'Sin resultados';
    document.getElementById('detMeta').textContent = '';
    document.getElementById('detOverview').textContent = '';
    return;
  }
  heroEl.style.backgroundImage = `url("${item.backdrop || item.poster}")`;
  document.getElementById('ticketYear').textContent = item.year || '—';
  document.getElementById('detTitle').textContent = item.title;
  playBtnEl.textContent = state.catalog === 'series' ? '▶ Ver ficha' : '▶ Reproducir';

  const detMetaEl = document.getElementById('detMeta');
  detMetaEl.textContent = '';
  if (item.rating) {
    detMetaEl.appendChild(document.createTextNode('⭐ ' + item.rating.toFixed(1) + ' / 10'));
  }
  const extraText = state.catalog === 'series' ? formatSeasonCount(item.seasons) : formatRuntime(item.runtime);
  if (extraText) {
    const extraEl = document.createElement('span');
    extraEl.className = 'hero__extra';
    extraEl.textContent = `(${extraText})`;
    detMetaEl.appendChild(extraEl);
  }

  document.getElementById('detOverview').textContent = item.overview || 'Sin sinopsis disponible.';
}

function move(delta) {
  const movies = visibleItems();
  if (movies.length === 0) return;
  state.currentIndex = (state.currentIndex + delta + movies.length) % movies.length;
  updateActiveCard();
  renderHero();
  preloadNeighborBackdrops();
}

// Adelanta solo las 2 películas vecinas (izquierda/derecha) a la caché del
// navegador, para que ir moviéndose por el carrusel se note instantáneo.
// A propósito NO precargamos toda la biblioteca de golpe al arrancar: en la
// tele (mucho menos potente que un PC) descodificar de golpe decenas de
// imágenes pesadas satura la CPU y es justo lo que provocaba la lentitud.
//
// Tampoco lo hacemos al vuelo en cada ◀ ▶: si vas pasando varias películas
// seguidas (lo normal), cada pulsación lanzaría su propia descarga+decodificado
// compitiendo con el renderizado de lo que estás viendo en ese momento, que es
// justo cuando más se nota el tirón. Lo retrasamos un poco y lo dejamos para
// cuando el navegador esté libre, y solo se ejecuta una vez aunque pulses
// varias veces seguidas.
const preloadedBackdrops = new Set();
let preloadTimer = null;
function preloadNeighborBackdrops() {
  if (preloadTimer) clearTimeout(preloadTimer);
  preloadTimer = setTimeout(() => {
    const run = () => {
      const movies = visibleItems();
      if (movies.length === 0) return;
      [state.currentIndex - 1, state.currentIndex + 1].forEach(i => {
        const movie = movies[(i + movies.length) % movies.length];
        if (!movie || !movie.backdrop || preloadedBackdrops.has(movie.backdrop)) return;
        preloadedBackdrops.add(movie.backdrop);
        const img = new Image();
        img.src = movie.backdrop;
      });
    };
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1000 });
    else run();
  }, 300);
}

// ---------- Reproductor ----------

let currentObjectUrl = null;

async function playMovie(movie) {
  const video = document.getElementById('player');
  showView('player');
  if (movie.localFileHandle) {
    const file = await movie.localFileHandle.getFile();
    currentObjectUrl = URL.createObjectURL(file);
    video.src = currentObjectUrl;
  } else if (/^https?:\/\//i.test(movie.filePath || '')) {
    video.src = movie.filePath;
  } else {
    video.src = 'file://' + movie.filePath;
  }
  video.play().catch(() => { /* algunos webviews requieren interacción extra */ });
}

// Al pulsar OK/clic sobre el elemento activo: las películas se reproducen
// directamente (igual que siempre); las series abren su ficha de temporadas
// y episodios en vez de reproducir nada.
function activateCurrentItem() {
  const item = visibleItems()[state.currentIndex];
  if (!item) return;
  if (state.catalog === 'series') openSeriesDetail(item);
  else playMovie(item);
}

function stopPlayer() {
  const video = document.getElementById('player');
  if (state.nowPlayingEpisode && video.duration) {
    saveEpisodeProgress(state.nowPlayingEpisode.showId, state.nowPlayingEpisode.seasonNumber, state.nowPlayingEpisode.episodeNumber, video.currentTime, video.duration);
  }
  state.nowPlayingEpisode = null;

  video.pause();
  video.removeAttribute('src');
  video.load();
  if (currentObjectUrl) { URL.revokeObjectURL(currentObjectUrl); currentObjectUrl = null; }

  // Si el vídeo se quedó en pantalla completa (botón de los controles nativos),
  // el puntero del mando deja de funcionar en el resto de la app hasta que se
  // sale de verdad del modo pantalla completa del navegador.
  const fsElement = document.fullscreenElement || document.webkitFullscreenElement;
  if (fsElement) {
    if (document.exitFullscreen) document.exitFullscreen().catch(() => {});
    else if (document.webkitExitFullscreen) document.webkitExitFullscreen();
  }

  state.focusZone = 'carousel';
  showView('browse');
}

// ---------- Carga inicial ----------

async function loadLibrary() {
  showView('loading');
  try {
    let movies;
    if (isRealDevice) {
      const result = await scanServerForMovies();
      if (result.noServer) {
        setStatus('Configura la dirección del servidor en Ajustes (⚙) o en CONFIG.SERVER_URL dentro de js/app.js.');
        showView('error');
        return;
      }
      movies = result.movies;
    } else if (supportsFolderPicker) {
      // PC sin modo "tele": en vez de cargar películas de ejemplo, intenta
      // recuperar la carpeta que ya elegiste otra vez; si no hay ninguna
      // guardada (o ya no tiene permiso), pide elegirla de nuevo.
      if (await tryRestoreSavedFolder()) return;
      showView('pickfolder');
      return;
    } else {
      movies = mockMovies();
    }

    if (!movies.length) { showView('empty'); return; }

    state.movies = movies;
    await Promise.all(movies.map(resolvePoster));

    state.currentIndex = 0;
    showView('browse');
    renderRow();
    renderHero();
    preloadNeighborBackdrops();
  } catch (err) {
    setStatus(err && err.message);
    showView('error');
  }
}

async function loadMoviesFromHandle(rootHandle) {
  showView('loading');
  const { movies, series } = await scanLocalFolder(rootHandle);
  if (!movies.length && !series.length) { showView('empty'); return; }

  state.movies = movies;
  state.series = series;
  state.seriesLoaded = true;
  state.catalog = 'movies';
  setCatalogUI('movies');
  await Promise.all([...movies.map(resolvePoster), ...series.map(resolveSeriesInfo)]);

  state.currentIndex = 0;
  showView('browse');
  renderRow();
  renderHero();
  preloadNeighborBackdrops();
}

// Si ya elegiste una carpeta antes y el navegador todavía tiene permiso para
// leerla, la carga directamente sin volver a preguntar. queryPermission()
// (a diferencia de requestPermission()) no necesita que el usuario acabe de
// hacer clic, así que se puede comprobar solo, al arrancar la app.
async function tryRestoreSavedFolder() {
  try {
    const handle = await loadSavedFolderHandle();
    if (!handle) return false;
    const granted = (await handle.queryPermission({ mode: 'read' })) === 'granted';
    if (!granted) return false;
    await loadMoviesFromHandle(handle);
    return true;
  } catch (e) {
    return false; // sin carpeta guardada, o ya no es válida: se pedirá a mano
  }
}

// Elige una carpeta local (USB del PC) con el selector nativo del navegador.
// La usan tanto la pantalla inicial "Elegir carpeta" como el icono 📁 de la
// barra superior (para cambiar de carpeta más adelante).
async function pickLocalFolder() {
  try {
    const rootHandle = await window.showDirectoryPicker();
    saveFolderHandle(rootHandle).catch(() => { /* si falla, simplemente la pedirá otra vez la próxima */ });
    await loadMoviesFromHandle(rootHandle);
  } catch (err) {
    if (err && err.name === 'AbortError') { // canceló el selector de carpeta
      showView(state.movies.length ? 'browse' : 'pickfolder');
      return;
    }
    setStatus(err && err.message);
    showView('error');
  }
}

// ---------- Detección en caliente (sondeo del servidor) ----------

let lastMovieIds = null;

function startServerWatch() {
  if (!isRealDevice) return;
  setInterval(async () => {
    if (state.mode === 'player' || state.mode === 'loading') return; // no interrumpimos
    try {
      const result = await scanServerForMovies();
      if (result.noServer) return;
      const ids = result.movies.map(m => m.id).sort().join(',');

      if (lastMovieIds === null) { lastMovieIds = ids; return; }
      if (ids === lastMovieIds) return;
      lastMovieIds = ids;
      loadLibrary();
    } catch (e) { /* el servidor no responde ahora mismo, lo reintentamos en el siguiente ciclo */ }
  }, 15000);
}

// ---------- Ajustes ----------

const settingsPanel = document.getElementById('settingsPanel');

function openSettings() {
  document.getElementById('tmdbKeyInput').value = localStorage.getItem('tmdb_key') || '';
  document.getElementById('serverUrlInput').value = localStorage.getItem('server_url') || '';
  settingsPanel.hidden = false;
}
function closeSettings() { settingsPanel.hidden = true; }

document.getElementById('settingsBtn').addEventListener('click', openSettings);
document.getElementById('closeSettingsBtn').addEventListener('click', closeSettings);
document.getElementById('saveSettingsBtn').addEventListener('click', () => {
  const key = document.getElementById('tmdbKeyInput').value.trim();
  if (key) localStorage.setItem('tmdb_key', key);
  else localStorage.removeItem('tmdb_key');

  const serverUrl = document.getElementById('serverUrlInput').value.trim();
  if (serverUrl) localStorage.setItem('server_url', serverUrl);
  else localStorage.removeItem('server_url');

  closeSettings();
  loadLibrary(); // volvemos a cargar con la nueva clave/servidor
});

// ---------- Ficha ampliada (sinopsis, director, reparto) ----------

const detailModal = document.getElementById('detailModal');

function openDetail() {
  const movie = visibleItems()[state.currentIndex];
  if (!movie) return;
  document.getElementById('detailTitle').textContent = movie.title;
  document.getElementById('detailDirector').textContent = movie.director ? ('Director: ' + movie.director) : '';
  document.getElementById('detailOverviewFull').textContent = movie.overview || 'Sin sinopsis disponible.';
  document.getElementById('detailCast').textContent = (movie.cast && movie.cast.length) ? ('Reparto: ' + movie.cast.join(', ')) : '';
  detailModal.hidden = false;
}
function closeDetail() { detailModal.hidden = true; }

// La sinopsis del hero abre la ficha de la película, o la de temporadas y
// episodios si estamos en el catálogo de series.
function openItemDetail() {
  const item = visibleItems()[state.currentIndex];
  if (!item) return;
  if (state.catalog === 'series') openSeriesDetail(item);
  else openDetail();
}

document.getElementById('detOverview').addEventListener('click', openItemDetail);
document.getElementById('detOverview').addEventListener('keydown', (e) => {
  if (e.keyCode === 13) openItemDetail(); // OK sobre la sinopsis
});
document.getElementById('closeDetailBtn').addEventListener('click', closeDetail);

// ---------- Confirmación para salir de la app ----------

const exitModal = document.getElementById('exitModal');
const cancelExitBtn = document.getElementById('cancelExitBtn');
const exitBtn = document.getElementById('exitBtn');
const EXIT_BUTTONS = [cancelExitBtn, exitBtn]; // Cancelar por defecto, para no salir sin querer

function openExitConfirm() {
  exitModal.hidden = false;
  cancelExitBtn.focus();
}
function closeExitConfirm() { exitModal.hidden = true; }

cancelExitBtn.addEventListener('click', closeExitConfirm);
// window.close() es el método que documenta LG para que una app de webOS TV
// se cierre a sí misma (con un back-press en la pantalla raíz normalmente
// abre el diálogo nativo de salir; con uno propio, cerramos así). Como es un
// cierre real del proceso, si algo se había quedado colgado se soluciona
// solo con volver a abrir la app.
exitBtn.addEventListener('click', () => window.close());

document.getElementById('retryBtn').addEventListener('click', loadLibrary);
document.getElementById('retryBtn2').addEventListener('click', loadLibrary);
document.getElementById('playBtn').addEventListener('click', activateCurrentItem);

const searchInput = document.getElementById('searchInput');

function applySearch(value) {
  const v = value.trim();
  if (v === state.query) return;
  state.query = v;
  state.currentIndex = 0;
  renderRow();
  renderHero();
  preloadNeighborBackdrops();
}

// "input" cubre el teclado normal; algunos teclados virtuales de TV (webOS)
// no disparan "input" con cada pulsación, así que reforzamos con "keyup"
// y un sondeo mientras el campo tiene el foco.
searchInput.addEventListener('input', (e) => applySearch(e.target.value));
searchInput.addEventListener('keyup', (e) => applySearch(e.target.value));

let searchPoll = null;
searchInput.addEventListener('focus', () => {
  searchPoll = setInterval(() => applySearch(searchInput.value), 300);
});
searchInput.addEventListener('blur', () => {
  if (searchPoll) { clearInterval(searchPoll); searchPoll = null; }
});

const pickFolderBtn = document.getElementById('pickFolderBtn');
if (!isRealDevice && supportsFolderPicker) {
  pickFolderBtn.style.display = 'inline-block';
  pickFolderBtn.addEventListener('click', pickLocalFolder);
  document.getElementById('pickFolderMainBtn').addEventListener('click', pickLocalFolder);
}

// ---------- Arrastrar el carrusel con el ratón (solo PC, con inercia) ----------

if (!isRealDevice) {
  let dragging = false;
  let dragStartX = 0;
  let dragBaseShift = 0;
  let dragCurrentShift = 0;
  let dragDistance = 0;
  let lastMoveX = 0, lastMoveTime = 0, velocity = 0; // velocity en px/ms
  let inertiaFrame = null;

  function currentRowShift() {
    const m = /translateX\((-?\d+(?:\.\d+)?)px\)/.exec(carouselEl.style.transform);
    return m ? parseFloat(m[1]) : 0;
  }
  function setRowShift(px) { carouselEl.style.transform = `translateX(${px}px)`; }
  function stopInertia() { if (inertiaFrame) { cancelAnimationFrame(inertiaFrame); inertiaFrame = null; } }

  function snapToNearestCard() {
    const movies = visibleItems();
    if (!movies.length) return;
    const idxFloat = (carouselWrapWidth / 2 - 90 - dragCurrentShift) / CARD_STEP;
    state.currentIndex = Math.max(0, Math.min(movies.length - 1, Math.round(idxFloat)));
    carouselEl.classList.remove('row--dragging'); // reactiva la transición CSS: el "snap" queda suave
    updateActiveCard();
    renderHero();
    preloadNeighborBackdrops();
  }

  function runInertia() {
    velocity *= 0.94; // fricción
    dragCurrentShift += velocity * 16;
    setRowShift(dragCurrentShift);
    if (Math.abs(velocity) > 0.02) {
      inertiaFrame = requestAnimationFrame(runInertia);
    } else {
      inertiaFrame = null;
      snapToNearestCard();
    }
  }

  carouselEl.addEventListener('mousedown', (e) => {
    if (state.mode !== 'browse') return;
    stopInertia();
    dragging = true;
    dragDistance = 0;
    dragStartX = e.clientX;
    dragBaseShift = currentRowShift();
    dragCurrentShift = dragBaseShift;
    lastMoveX = e.clientX;
    lastMoveTime = performance.now();
    velocity = 0;
    carouselEl.classList.add('row--dragging');
    e.preventDefault();
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.clientX - dragStartX;
    dragDistance = Math.abs(dx);
    dragCurrentShift = dragBaseShift + dx;
    setRowShift(dragCurrentShift);

    const now = performance.now();
    const dt = now - lastMoveTime;
    if (dt > 0) velocity = (e.clientX - lastMoveX) / dt;
    lastMoveX = e.clientX;
    lastMoveTime = now;
  });

  window.addEventListener('mouseup', () => {
    if (!dragging) return;
    dragging = false;
    if (dragDistance < 4) { carouselEl.classList.remove('row--dragging'); return; } // fue un clic normal
    if (Math.abs(velocity) > 0.03) inertiaFrame = requestAnimationFrame(runInertia);
    else snapToNearestCard();
  });

  // Si el ratón se movió de verdad, el "click" que sigue al soltar no debe
  // contarse como selección/reproducción de la tarjeta.
  carouselEl.addEventListener('click', (e) => {
    if (dragDistance >= 4) { e.stopPropagation(); e.preventDefault(); }
  }, true);
}

// ---------- Progreso de episodios ("Seguir viendo") ----------

function episodeProgressKey(showId, seasonNumber, episodeNumber) {
  return `progress_${showId}_S${seasonNumber}E${episodeNumber}`;
}

function getEpisodeProgress(showId, seasonNumber, episodeNumber) {
  try {
    return JSON.parse(localStorage.getItem(episodeProgressKey(showId, seasonNumber, episodeNumber))) || null;
  } catch (e) { return null; }
}

// Un episodio cuenta como visto al llegar al 80% de su duración.
function saveEpisodeProgress(showId, seasonNumber, episodeNumber, positionSeconds, durationSeconds) {
  const watched = durationSeconds > 0 && (positionSeconds / durationSeconds) >= 0.8;
  localStorage.setItem(episodeProgressKey(showId, seasonNumber, episodeNumber), JSON.stringify({ positionSeconds, durationSeconds, watched }));
}

function flattenEpisodes(show) {
  const list = [];
  show.seasons.slice().sort((a, b) => a.seasonNumber - b.seasonNumber).forEach(season => {
    season.episodes.slice().sort((a, b) => a.episodeNumber - b.episodeNumber).forEach(ep => {
      list.push({ seasonNumber: season.seasonNumber, episodeNumber: ep.episodeNumber });
    });
  });
  return list;
}

// El primer episodio (en orden) que no esté visto es el objetivo de "Seguir
// viendo": si tiene progreso guardado, se retoma ahí; si no, empieza desde 0.
// Si no queda ninguno, la serie está completa (null).
function findContinueWatchingTarget(show) {
  const flat = flattenEpisodes(show);
  for (const item of flat) {
    const p = getEpisodeProgress(show.id, item.seasonNumber, item.episodeNumber);
    if (!p || !p.watched) {
      return { seasonNumber: item.seasonNumber, episodeNumber: item.episodeNumber, resumeSeconds: p ? p.positionSeconds : 0 };
    }
  }
  return null;
}

function playEpisode(show, seasonNumber, episodeNumber, resumeSeconds) {
  const season = show.seasons.find(s => s.seasonNumber === seasonNumber);
  const episode = season && season.episodes.find(e => e.episodeNumber === episodeNumber);
  if (!episode) return;

  const video = document.getElementById('player');
  showView('player');
  state.nowPlayingEpisode = { showId: show.id, seasonNumber, episodeNumber };
  localStorage.setItem('lastWatchedShowId', show.id); // para el "Seguir viendo" del hero, válido para cualquier serie

  const applyResume = () => {
    if (resumeSeconds > 5) video.addEventListener('loadedmetadata', () => { video.currentTime = resumeSeconds; }, { once: true });
    video.play().catch(() => {});
  };

  if (episode.localFileHandle) {
    episode.localFileHandle.getFile().then(file => {
      currentObjectUrl = URL.createObjectURL(file);
      video.src = currentObjectUrl;
      applyResume();
    });
  } else {
    video.src = episode.videoUrl;
    applyResume();
  }
  closeSeriesDetail();
}

// Guarda el progreso cada ~5s mientras se reproduce un episodio (no en cada
// "timeupdate", que dispara varias veces por segundo).
let progressSaveTimer = null;
document.getElementById('player').addEventListener('timeupdate', (e) => {
  if (!state.nowPlayingEpisode || progressSaveTimer) return;
  progressSaveTimer = setTimeout(() => {
    progressSaveTimer = null;
    const v = e.target;
    if (state.nowPlayingEpisode && v.duration) {
      saveEpisodeProgress(state.nowPlayingEpisode.showId, state.nowPlayingEpisode.seasonNumber, state.nowPlayingEpisode.episodeNumber, v.currentTime, v.duration);
    }
  }, 5000);
});

// ---------- Ficha de serie (temporadas, episodios, seguir viendo) ----------

const seriesDetailModal = document.getElementById('seriesDetailModal');
let seriesDetailShow = null;
let seriesDetailSeason = null;
let seriesFocusList = [];
let seriesFocusIndex = 0;

function episodeStatus(show, seasonNumber, episodeNumber) {
  const p = getEpisodeProgress(show.id, seasonNumber, episodeNumber);
  if (!p) return { text: '', cls: '' };
  if (p.watched) return { text: 'Visto', cls: 'episode-row__status--watched' };
  if (p.positionSeconds > 5 && p.durationSeconds) {
    return { text: Math.round((p.positionSeconds / p.durationSeconds) * 100) + '%', cls: 'episode-row__status--progress' };
  }
  return { text: '', cls: '' };
}

function renderSeriesSeasonTabs() {
  const wrap = document.getElementById('seriesSeasonTabs');
  wrap.innerHTML = '';
  seriesDetailShow.seasons.slice().sort((a, b) => a.seasonNumber - b.seasonNumber).forEach(season => {
    const btn = document.createElement('button');
    btn.className = 'season-tab' + (season.seasonNumber === seriesDetailSeason ? ' season-tab--active' : '');
    btn.textContent = `Temporada ${season.seasonNumber}`;
    btn.addEventListener('click', () => {
      seriesDetailSeason = season.seasonNumber;
      renderSeriesDetailBody();
      const activeTab = document.querySelector('#seriesSeasonTabs .season-tab--active');
      const idx = seriesFocusList.indexOf(activeTab);
      seriesFocusIndex = idx >= 0 ? idx : 0;
      if (seriesFocusList[seriesFocusIndex]) seriesFocusList[seriesFocusIndex].focus();
    });
    wrap.appendChild(btn);
  });
}

function renderSeriesEpisodeList() {
  const wrap = document.getElementById('seriesEpisodeList');
  wrap.innerHTML = '';
  const season = seriesDetailShow.seasons.find(s => s.seasonNumber === seriesDetailSeason);
  if (!season) return;

  season.episodes.slice().sort((a, b) => a.episodeNumber - b.episodeNumber).forEach(ep => {
    const row = document.createElement('div');
    row.className = 'episode-row';
    row.tabIndex = 0;

    const num = document.createElement('span');
    num.className = 'episode-row__num';
    num.textContent = ep.episodeNumber;

    const info = document.createElement('div');
    info.className = 'episode-row__info';
    const title = document.createElement('span');
    title.className = 'episode-row__title';
    title.textContent = ep.title || `Episodio ${ep.episodeNumber}`;
    info.appendChild(title);
    const runtimeText = formatRuntime(ep.runtime);
    if (runtimeText) {
      const runtimeEl = document.createElement('span');
      runtimeEl.className = 'episode-row__runtime';
      runtimeEl.textContent = runtimeText;
      info.appendChild(runtimeEl);
    }

    const status = document.createElement('span');
    const st = episodeStatus(seriesDetailShow, seriesDetailSeason, ep.episodeNumber);
    status.className = 'episode-row__status' + (st.cls ? ' ' + st.cls : '');
    status.textContent = st.text;

    row.appendChild(num);
    row.appendChild(info);
    row.appendChild(status);

    const activate = () => {
      const p = getEpisodeProgress(seriesDetailShow.id, seriesDetailSeason, ep.episodeNumber);
      playEpisode(seriesDetailShow, seriesDetailSeason, ep.episodeNumber, (p && !p.watched) ? p.positionSeconds : 0);
    };
    row.addEventListener('click', activate);
    row.addEventListener('keydown', (e) => { if (e.keyCode === 13) activate(); });

    wrap.appendChild(row);
  });
}

function renderSeriesDetailBody() {
  renderSeriesSeasonTabs();
  renderSeriesEpisodeList();
  seriesFocusList = [
    document.getElementById('seriesContinueBtn'),
    document.getElementById('seriesWatchBtn'),
    ...document.querySelectorAll('#seriesSeasonTabs .season-tab'),
    ...document.querySelectorAll('#seriesEpisodeList .episode-row'),
  ];
}

function openSeriesDetail(show) {
  seriesDetailShow = show;
  const target = findContinueWatchingTarget(show);
  seriesDetailSeason = target ? target.seasonNumber : ((show.seasons[0] && show.seasons[0].seasonNumber) || 1);

  document.getElementById('seriesDetailTitle').textContent = show.title;
  const metaParts = [show.year, show.rating ? ('⭐ ' + show.rating.toFixed(1) + ' / 10') : '', formatSeasonCount(show.seasons)];
  document.getElementById('seriesDetailMeta').textContent = metaParts.filter(Boolean).join('   ·   ');
  document.getElementById('seriesDetailOverview').textContent = show.overview || 'Sin sinopsis disponible.';

  const continueBtn = document.getElementById('seriesContinueBtn');
  continueBtn.disabled = !target;
  continueBtn.textContent = target ? 'Seguir viendo' : 'Serie completada';

  renderSeriesDetailBody();
  seriesDetailModal.hidden = false;
  seriesFocusIndex = 0;
  if (seriesFocusList[0]) seriesFocusList[0].focus();
}

function closeSeriesDetail() { seriesDetailModal.hidden = true; }

document.getElementById('seriesWatchBtn').addEventListener('click', () => {
  const flat = flattenEpisodes(seriesDetailShow);
  if (flat.length) playEpisode(seriesDetailShow, flat[0].seasonNumber, flat[0].episodeNumber, 0);
});
document.getElementById('seriesContinueBtn').addEventListener('click', () => {
  const target = findContinueWatchingTarget(seriesDetailShow);
  if (target) playEpisode(seriesDetailShow, target.seasonNumber, target.episodeNumber, target.resumeSeconds);
});
document.getElementById('closeSeriesDetailBtn').addEventListener('click', closeSeriesDetail);

// ---------- Selector Películas / Series ----------

function setCatalogUI(name) {
  document.body.classList.toggle('theme-series', name === 'series');
  // El botón siempre dice a qué modo cambiarías si lo pulsas; su color ya
  // sale solo de var(--red), que cambia con el tema (rojo/verde).
  catalogToggleBtn.textContent = name === 'series' ? 'Películas' : 'Series';
  document.getElementById('rowTitle').textContent = name === 'series' ? 'Mis series' : 'Mi colección';
  searchInput.placeholder = name === 'series' ? 'Buscar series…' : 'Buscar películas…';
}

// Solo hace falta pedir series al servidor (modo tele/?server=1); en el modo
// PC sin servidor, elegir carpeta ya carga ambos catálogos de una vez.
async function loadSeriesLibrary() {
  if (!isRealDevice) return;
  try {
    const result = await scanServerForSeries();
    if (result.noServer) return;
    state.series = result.series;
    await Promise.all(state.series.map(resolveSeriesInfo));
    state.seriesLoaded = true;
  } catch (e) { /* Series se queda vacío; se reintenta la próxima vez que cambies de pestaña */ }
}

async function switchCatalog(name) {
  if (state.catalog === name) return;
  state.catalog = name;
  state.currentIndex = 0;
  state.query = '';
  searchInput.value = '';
  setCatalogUI(name);

  if (name === 'series' && !state.seriesLoaded) {
    document.getElementById('loadingText').textContent = 'Buscando series…';
    showView('loading');
    await loadSeriesLibrary();
  }
  showView('browse');
  renderRow();
  renderHero();
  preloadNeighborBackdrops();
}

const catalogToggleBtn = document.getElementById('catalogToggleBtn');
catalogToggleBtn.addEventListener('click', () => switchCatalog(state.catalog === 'series' ? 'movies' : 'series'));

// ---------- Control remoto / teclado ----------

// Orden de la navegación hacia arriba desde el carrusel: Reproducir → Seguir
// viendo (si está visible) → Descripción → Buscador → cambiar de
// Películas/Series → Ajustes. Así se puede usar toda la app solo con las
// flechas del mando, sin depender del puntero ni de las teclas numéricas 1/2.
// Es una función (no una lista fija) porque "Seguir viendo" solo entra en la
// cadena cuando renderHero() lo muestra.
function navElements() {
  const list = [document.getElementById('playBtn')];
  const continueBtn = document.getElementById('heroContinueBtn');
  if (!continueBtn.hidden) list.push(continueBtn);
  list.push(document.getElementById('detOverview'), searchInput, catalogToggleBtn, document.getElementById('settingsBtn'));
  return list;
}

function focusNav(index) {
  state.focusZone = 'nav';
  state.navIndex = index;
  navElements()[index].focus();
}

function focusCarousel() {
  state.focusZone = 'carousel';
  if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
}

document.addEventListener('keydown', (e) => {
  const BACK_KEY = 461; // tecla "atrás" del mando LG

  // El Enter/OK lo gestionamos siempre nosotros a mano (con .click() explícitos
  // donde toca). Sin esto, si un mismo OK abre un modal y mueve el foco a un
  // <button> (p. ej. al abrir la ficha de una serie), el navegador dispara
  // ADEMÁS su propia activación nativa de "Enter sobre el botón enfocado" para
  // esa misma pulsación, y acaba reproduciendo algo que no tocaste.
  if (e.keyCode === 13 && e.target.tagName !== 'INPUT') e.preventDefault();

  if (!detailModal.hidden) {
    if (e.keyCode === BACK_KEY || e.keyCode === 8 || e.keyCode === 27) closeDetail();
    return; // no interfiere con la navegación del carrusel mientras el modal está abierto
  }

  if (!seriesDetailModal.hidden) {
    if (e.keyCode === BACK_KEY || e.keyCode === 8 || e.keyCode === 27) closeSeriesDetail();
    else if (e.keyCode === 38) { seriesFocusIndex = Math.max(0, seriesFocusIndex - 1); seriesFocusList[seriesFocusIndex] && seriesFocusList[seriesFocusIndex].focus(); }
    else if (e.keyCode === 40) { seriesFocusIndex = Math.min(seriesFocusList.length - 1, seriesFocusIndex + 1); seriesFocusList[seriesFocusIndex] && seriesFocusList[seriesFocusIndex].focus(); }
    else if (e.keyCode === 13) document.activeElement.click();
    return;
  }

  if (!exitModal.hidden) {
    if (e.keyCode === 37 || e.keyCode === 39) {           // izquierda/derecha: alterna Cancelar/Salir
      const i = EXIT_BUTTONS.indexOf(document.activeElement);
      EXIT_BUTTONS[i === 0 ? 1 : 0].focus();
    } else if (e.keyCode === 13) {                        // OK: activa el botón enfocado
      document.activeElement.click();
    } else if (e.keyCode === BACK_KEY || e.keyCode === 8 || e.keyCode === 27) {
      closeExitConfirm();                                 // atrás: cancela, no cierra la app
    }
    return;
  }

  if (e.target === searchInput) {
    // Dentro del campo de búsqueda dejamos que izquierda/derecha muevan el
    // cursor de texto con normalidad; solo interceptamos arriba/abajo.
    if (e.keyCode === 38) { e.preventDefault(); focusNav((state.navIndex + 1) % navElements().length); return; }
    if (e.keyCode === 40) { e.preventDefault(); state.navIndex === 0 ? focusCarousel() : focusNav(state.navIndex - 1); return; }
    return;
  }

  if (state.mode === 'browse') {
    // Teclas numéricas 1/2 del mando (mismo keyCode que en un teclado normal):
    // cambian de catálogo al instante, salvo si estás escribiendo en un campo.
    if (document.activeElement.tagName !== 'INPUT' && (e.keyCode === 49 || e.keyCode === 50)) {
      switchCatalog(e.keyCode === 49 ? 'movies' : 'series');
      return;
    }
    if (state.focusZone === 'nav') {
      if (e.keyCode === 38) focusNav((state.navIndex + 1) % navElements().length);      // arriba
      else if (e.keyCode === 40) { state.navIndex === 0 ? focusCarousel() : focusNav(state.navIndex - 1); } // abajo
      else if (e.keyCode === 13) navElements()[state.navIndex].click();                 // OK
      else if (e.keyCode === BACK_KEY || e.keyCode === 8) focusCarousel();             // atrás
      return;
    }
    if (e.keyCode === 37) move(-1);          // izquierda
    else if (e.keyCode === 39) move(1);      // derecha
    else if (e.keyCode === 38) focusNav(0);  // arriba: sube a "Reproducir"
    else if (e.keyCode === 13) activateCurrentItem(); // OK
    else if (e.keyCode === BACK_KEY || e.keyCode === 8 || e.keyCode === 27) {
      openExitConfirm();                     // atrás desde la pantalla principal: confirmar salida
    }
  } else if (state.mode === 'player') {
    if (e.keyCode === BACK_KEY || e.keyCode === 8 || e.keyCode === 27) stopPlayer();
  }
  if (e.keyCode === 27 && !settingsPanel.hidden) closeSettings();
});

window.addEventListener("resize", () => { if (state.mode === "browse") renderRow(); });

// ---------- Contraseña de acceso (solo si CONFIG.SITE_PASSWORD tiene algo) ----------

function needsLogin() {
  return !isRealDevice && !!CONFIG.SITE_PASSWORD && localStorage.getItem('nf_unlocked') !== '1';
}

const topbarActionsEl = document.querySelector('.topbar__actions');

function attemptLogin() {
  const input = document.getElementById('loginPasswordInput');
  if (input.value.trim().toLowerCase() === CONFIG.SITE_PASSWORD.toLowerCase()) {
    localStorage.setItem('nf_unlocked', '1');
    document.getElementById('loginError').hidden = true;
    topbarActionsEl.classList.remove('topbar__actions--locked');
    loadLibrary();
  } else {
    document.getElementById('loginError').hidden = false;
    input.value = '';
    input.focus();
  }
}

document.getElementById('loginSubmitBtn').addEventListener('click', attemptLogin);
document.getElementById('loginPasswordInput').addEventListener('keydown', (e) => {
  if (e.keyCode === 13) attemptLogin();
});

if (needsLogin()) {
  showView('login');
  topbarActionsEl.classList.add('topbar__actions--locked'); // sin Ajustes ni elegir carpeta hasta acertar la contraseña
  document.getElementById('loginPasswordInput').focus();
} else {
  loadLibrary();
}
startServerWatch();
