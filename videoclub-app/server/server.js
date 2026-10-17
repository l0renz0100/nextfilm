/* ============================================================
   Servidor de películas y series para Nextfilm.
   Corre en tu PC (donde está el USB conectado) y sirve, por tu
   red local, el catálogo, el vídeo y las carátulas — la tele solo
   hace peticiones HTTP normales, sin depender de ningún permiso
   especial de webOS ni de su propia conexión a internet.

   Al arrancar, resuelve carátula/fondo/sinopsis/reparto (y en
   series, temporadas y episodios) con TMDb UNA vez y descarga las
   imágenes a server/cache/, sirviéndolas luego desde ahí. La caché
   se borra y se rehace entera en cada arranque, así no hay que
   preocuparse de sincronizarla si añades o quitas contenido —
   solo reinicia el servidor.

   Uso:
     node server/server.js "D:\ruta\a\tu\carpeta raiz" [puerto]

   La carpeta que pases debe contener dos subcarpetas:
     <raiz>/Peliculas/Título (Año)/vídeo.ext
     <raiz>/Series/Nombre de la Serie (Año)/Temporada 01/Capítulo 01/vídeo.ext

   Si no pasas la carpeta, usa "server/biblioteca" por defecto.
   Si no pasas puerto, usa el 8080.
   ============================================================ */

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG = {
  // Misma clave que en CONFIG.TMDB_API_KEY de js/app.js.
  TMDB_API_KEY: 'a05d781482f8465ebdbf69ed5fb6c5a5',
};

const PORT = Number(process.argv[3]) || 8080;
const ROOT_DIR = process.argv[2] || path.join(__dirname, 'biblioteca');
const CACHE_DIR = path.join(__dirname, 'cache');
const SERIES_CACHE_DIR = path.join(CACHE_DIR, 'series');

// Busca dentro de ROOT_DIR una subcarpeta con ese nombre, sin distinguir
// mayúsculas ni acentos (para admitir "Peliculas", "Películas", etc.).
function findSubfolder(root, name) {
  if (!fs.existsSync(root)) return null;
  const normalize = s => s.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
  const target = normalize(name);
  const entries = fs.readdirSync(root, { withFileTypes: true }).filter(e => e.isDirectory());
  const match = entries.find(e => normalize(e.name) === target);
  return match ? path.join(root, match.name) : null;
}

const MOVIES_DIR = findSubfolder(ROOT_DIR, 'peliculas');
const SERIES_DIR = findSubfolder(ROOT_DIR, 'series');

const VIDEO_EXTENSIONS = ['.mp4', '.mkv', '.avi', '.mov', '.m4v', '.webm'];
const POSTER_FILENAMES = ['poster.jpg', 'poster.png', 'cover.jpg', 'folder.jpg'];
const MIME_TYPES = {
  '.mp4': 'video/mp4', '.mkv': 'video/x-matroska', '.avi': 'video/x-msvideo',
  '.mov': 'video/quicktime', '.m4v': 'video/x-m4v', '.webm': 'video/webm',
  '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png',
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
};

// Sirve la propia app (index.html, css/, js/, iconos...) para poder abrirla
// como http://localhost:PUERTO/ en vez de con file:// — con un origen HTTP
// real, el navegador recuerda mejor permisos guardados (como la carpeta del
// USB elegida a mano). Es solo para probar cómodamente en el PC: la tele
// carga su propia copia instalada, no esta.
const APP_ROOT = path.join(__dirname, '..');
function serveStatic(res, pathname) {
  const rel = pathname === '/' ? '/index.html' : pathname;
  const filePath = path.join(APP_ROOT, decodeURIComponent(rel));
  if (!filePath.startsWith(APP_ROOT) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); return res.end('No encontrado');
  }
  const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': mime });
  fs.createReadStream(filePath).pipe(res);
}

function parseTitleYear(folderName) {
  const match = folderName.match(/^(.*?)\s*\((\d{4})\)\s*$/);
  if (match) return { title: match[1].trim(), year: match[2] };
  return { title: folderName.trim(), year: null };
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|]/g, '_');
}

function scanRawMovies() {
  if (!MOVIES_DIR || !fs.existsSync(MOVIES_DIR)) return [];
  const entries = fs.readdirSync(MOVIES_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  const movies = [];
  for (const entry of entries) {
    const folderPath = path.join(MOVIES_DIR, entry.name);
    const files = fs.readdirSync(folderPath);
    const videoFile = files.find(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
    if (!videoFile) continue;
    const posterFile = files.find(f => POSTER_FILENAMES.includes(f.toLowerCase()));
    const { title, year } = parseTitleYear(entry.name);
    movies.push({
      id: entry.name,
      title, year,
      videoFile: path.join(folderPath, videoFile),
      localPosterFile: posterFile ? path.join(folderPath, posterFile) : null,
    });
  }
  return movies;
}

// Extrae el número de una carpeta de temporada ("Temporada 01", "Season 2"...);
// si no hay número, usa la posición en la que aparece (orden alfabético).
function seasonNumberFromFolder(name, fallbackIndex) {
  const match = name.match(/(\d+)/);
  return match ? parseInt(match[1], 10) : fallbackIndex + 1;
}

function scanRawSeries() {
  if (!SERIES_DIR || !fs.existsSync(SERIES_DIR)) return [];
  const showEntries = fs.readdirSync(SERIES_DIR, { withFileTypes: true }).filter(e => e.isDirectory());
  const shows = [];
  for (const showEntry of showEntries) {
    const showPath = path.join(SERIES_DIR, showEntry.name);
    const showFiles = fs.readdirSync(showPath, { withFileTypes: true });
    const posterFile = showFiles.find(f => f.isFile() && POSTER_FILENAMES.includes(f.name.toLowerCase()));
    const seasonFolders = showFiles.filter(f => f.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

    const seasons = [];
    seasonFolders.forEach((seasonEntry, seasonIndex) => {
      const seasonPath = path.join(showPath, seasonEntry.name);
      // Una carpeta por episodio dentro de la temporada (misma idea que
      // "Película (Año)/vídeo.ext"): el nombre de la carpeta da el orden,
      // y dentro se busca el archivo de vídeo, se llame como se llame.
      const episodeFolders = fs.readdirSync(seasonPath, { withFileTypes: true })
        .filter(f => f.isDirectory())
        .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

      const episodes = [];
      episodeFolders.forEach((episodeEntry, i) => {
        const episodePath = path.join(seasonPath, episodeEntry.name);
        const videoFile = fs.readdirSync(episodePath)
          .find(f => VIDEO_EXTENSIONS.includes(path.extname(f).toLowerCase()));
        if (!videoFile) return;
        episodes.push({
          episodeNumber: i + 1,
          videoFile: path.join(episodePath, videoFile),
          title: null, runtime: null, // se rellenan con enrichShowWithTmdb si hay clave
        });
      });
      if (!episodes.length) return;

      const seasonNumber = seasonNumberFromFolder(seasonEntry.name, seasonIndex);
      seasons.push({ seasonNumber, episodes });
    });
    if (!seasons.length) continue;

    const { title, year } = parseTitleYear(showEntry.name);
    shows.push({
      id: showEntry.name,
      title, year,
      seasons,
      localPosterFile: posterFile ? path.join(showPath, posterFile.name) : null,
    });
  }
  return shows;
}

async function downloadImage(url, destPath) {
  const r = await fetch(url);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  const buffer = Buffer.from(await r.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
}

// Busca la película en TMDb y descarga carátula/fondo a server/cache/.
// No lanza excepción si algo falla: la película simplemente se queda sin
// esos datos y la app usa su carátula genérica de repuesto.
async function enrichWithTmdb(movie) {
  const key = CONFIG.TMDB_API_KEY;
  if (!key || key === 'PON_AQUI_TU_API_KEY') return;

  try {
    const searchUrl = `https://api.themoviedb.org/3/search/movie?api_key=${key}&language=es-ES&query=${encodeURIComponent(movie.title)}${movie.year ? ('&year=' + movie.year) : ''}`;
    const sr = await fetch(searchUrl);
    const sdata = await sr.json();
    const hit = sdata.results && sdata.results[0];
    if (!hit) return;

    movie.overview = hit.overview || '';
    movie.rating = hit.vote_average;

    const base = safeFileName(movie.id);

    if (!movie.localPosterFile && hit.poster_path) {
      const posterDest = path.join(CACHE_DIR, base + '-poster.jpg');
      await downloadImage('https://image.tmdb.org/t/p/w500' + hit.poster_path, posterDest);
      movie.posterCacheFile = posterDest;
    }
    if (hit.backdrop_path) {
      const backdropDest = path.join(CACHE_DIR, base + '-backdrop.jpg');
      await downloadImage('https://image.tmdb.org/t/p/w1280' + hit.backdrop_path, backdropDest);
      movie.backdropCacheFile = backdropDest;
    }

    const detailsUrl = `https://api.themoviedb.org/3/movie/${hit.id}?api_key=${key}&language=es-ES&append_to_response=credits`;
    const dr = await fetch(detailsUrl);
    const ddata = await dr.json();
    movie.runtime = ddata.runtime || null; // minutos
    const directorEntry = ((ddata.credits && ddata.credits.crew) || []).find(c => c.job === 'Director');
    movie.director = directorEntry ? directorEntry.name : '';
    movie.cast = ((ddata.credits && ddata.credits.cast) || []).slice(0, 6).map(c => c.name);
  } catch (e) {
    console.log(`  ! No se pudo traer info de TMDb para "${movie.title}": ${e.message}`);
  }
}

// Igual que enrichWithTmdb, pero para una serie: además de carátula/fondo/
// sinopsis, por cada temporada detectada localmente pide sus episodios a
// TMDb y empareja por número de episodio para sacar título y duración.
async function enrichShowWithTmdb(show) {
  const key = CONFIG.TMDB_API_KEY;
  if (!key || key === 'PON_AQUI_TU_API_KEY') return;

  try {
    const searchUrl = `https://api.themoviedb.org/3/search/tv?api_key=${key}&language=es-ES&query=${encodeURIComponent(show.title)}${show.year ? ('&first_air_date_year=' + show.year) : ''}`;
    const sr = await fetch(searchUrl);
    const sdata = await sr.json();
    const hit = sdata.results && sdata.results[0];
    if (!hit) return;

    show.overview = hit.overview || '';
    show.rating = hit.vote_average;

    const base = safeFileName(show.id);

    if (!show.localPosterFile && hit.poster_path) {
      const posterDest = path.join(SERIES_CACHE_DIR, base + '-poster.jpg');
      await downloadImage('https://image.tmdb.org/t/p/w500' + hit.poster_path, posterDest);
      show.posterCacheFile = posterDest;
    }
    if (hit.backdrop_path) {
      const backdropDest = path.join(SERIES_CACHE_DIR, base + '-backdrop.jpg');
      await downloadImage('https://image.tmdb.org/t/p/w1280' + hit.backdrop_path, backdropDest);
      show.backdropCacheFile = backdropDest;
    }

    const detailsUrl = `https://api.themoviedb.org/3/tv/${hit.id}?api_key=${key}&language=es-ES&append_to_response=credits`;
    const dr = await fetch(detailsUrl);
    const ddata = await dr.json();
    show.creator = ((ddata.created_by || [])[0] || {}).name || '';
    show.cast = ((ddata.credits && ddata.credits.cast) || []).slice(0, 6).map(c => c.name);

    for (const season of show.seasons) {
      try {
        const seasonUrl = `https://api.themoviedb.org/3/tv/${hit.id}/season/${season.seasonNumber}?api_key=${key}&language=es-ES`;
        const sr2 = await fetch(seasonUrl);
        const seasonData = await sr2.json();
        const tmdbEpisodes = seasonData.episodes || [];
        season.episodes.forEach(ep => {
          const match = tmdbEpisodes.find(te => te.episode_number === ep.episodeNumber);
          ep.title = match && match.name ? match.name : `Episodio ${ep.episodeNumber}`;
          ep.runtime = match && match.runtime ? match.runtime : null;
        });
      } catch (e) {
        season.episodes.forEach(ep => { ep.title = ep.title || `Episodio ${ep.episodeNumber}`; });
      }
    }
  } catch (e) {
    console.log(`  ! No se pudo traer info de TMDb para "${show.title}": ${e.message}`);
  } finally {
    show.seasons.forEach(season => season.episodes.forEach(ep => {
      if (!ep.title) ep.title = `Episodio ${ep.episodeNumber}`;
    }));
  }
}

let library = []; // se rellena en buildLibrary(), antes de aceptar peticiones
let seriesLibrary = []; // se rellena en buildSeriesLibrary(), antes de aceptar peticiones

async function buildLibrary() {
  const movies = scanRawMovies();
  if (!movies.length) {
    console.log('\nNo se ha detectado ninguna película en esa carpeta.');
    return [];
  }

  console.log(`\nPelículas detectadas (${movies.length}). Descargando carátulas de TMDb...`);
  let done = 0;
  for (const movie of movies) {
    await enrichWithTmdb(movie);
    done++;
    console.log(`  [${done}/${movies.length}] ${movie.title}${movie.year ? ' (' + movie.year + ')' : ''}`);
  }
  console.log('Carátulas listas.');
  return movies;
}

async function buildSeriesLibrary() {
  const shows = scanRawSeries();
  if (!shows.length) {
    console.log('\nNo se ha detectado ninguna serie en esa carpeta.');
    return [];
  }

  console.log(`\nSeries detectadas (${shows.length}). Descargando info de TMDb...`);
  let done = 0;
  for (const show of shows) {
    await enrichShowWithTmdb(show);
    done++;
    const episodeCount = show.seasons.reduce((n, s) => n + s.episodes.length, 0);
    console.log(`  [${done}/${shows.length}] ${show.title}${show.year ? ' (' + show.year + ')' : ''} — ${show.seasons.length} temporada(s), ${episodeCount} episodio(s)`);
  }
  console.log('Series listas.');
  return shows;
}

function sendJson(res, status, data) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
  });
  res.end(JSON.stringify(data));
}

function streamFile(req, res, filePath, mime) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const headers = { 'Access-Control-Allow-Origin': '*', 'Content-Type': mime, 'Accept-Ranges': 'bytes' };

  if (range) {
    const [startStr, endStr] = range.replace(/bytes=/, '').split('-');
    const start = parseInt(startStr, 10);
    const end = endStr ? parseInt(endStr, 10) : stat.size - 1;
    headers['Content-Range'] = `bytes ${start}-${end}/${stat.size}`;
    headers['Content-Length'] = end - start + 1;
    res.writeHead(206, headers);
    fs.createReadStream(filePath, { start, end }).pipe(res);
  } else {
    headers['Content-Length'] = stat.size;
    res.writeHead(200, headers);
    fs.createReadStream(filePath).pipe(res);
  }
}

function findMovie(id) { return library.find(m => m.id === id); }
function findShow(id) { return seriesLibrary.find(s => s.id === id); }
function findEpisode(showId, seasonNumber, episodeNumber) {
  const show = findShow(showId);
  const season = show && show.seasons.find(s => s.seasonNumber === seasonNumber);
  const episode = season && season.episodes.find(e => e.episodeNumber === episodeNumber);
  return episode || null;
}

const server = http.createServer((req, res) => {
  let url;
  try {
    url = new URL(req.url, `http://${req.headers.host}`);
  } catch (e) {
    res.writeHead(400); return res.end('Petición no válida');
  }

  if (url.pathname === '/api/movies') {
    const host = `http://${req.headers.host}`;
    const movies = library.map(m => ({
      id: m.id, title: m.title, year: m.year,
      videoUrl: `${host}/video/${encodeURIComponent(m.id)}`,
      posterUrl: (m.localPosterFile || m.posterCacheFile) ? `${host}/cache/${encodeURIComponent(m.id)}/poster` : null,
      backdropUrl: m.backdropCacheFile ? `${host}/cache/${encodeURIComponent(m.id)}/backdrop` : null,
      overview: m.overview || '',
      rating: m.rating,
      runtime: m.runtime || null,
      director: m.director || '',
      cast: m.cast || [],
    }));
    return sendJson(res, 200, { movies });
  }

  if (url.pathname === '/api/series') {
    const host = `http://${req.headers.host}`;
    const shows = seriesLibrary.map(s => ({
      id: s.id, title: s.title, year: s.year,
      posterUrl: (s.localPosterFile || s.posterCacheFile) ? `${host}/cache/series/${encodeURIComponent(s.id)}/poster` : null,
      backdropUrl: s.backdropCacheFile ? `${host}/cache/series/${encodeURIComponent(s.id)}/backdrop` : null,
      overview: s.overview || '',
      rating: s.rating,
      creator: s.creator || '',
      cast: s.cast || [],
      seasons: s.seasons.map(season => ({
        seasonNumber: season.seasonNumber,
        episodes: season.episodes.map(ep => ({
          episodeNumber: ep.episodeNumber,
          title: ep.title,
          runtime: ep.runtime,
          videoUrl: `${host}/video/series/${encodeURIComponent(s.id)}/${season.seasonNumber}/${ep.episodeNumber}`,
        })),
      })),
    }));
    return sendJson(res, 200, { series: shows });
  }

  if (url.pathname.startsWith('/video/series/')) {
    const parts = url.pathname.slice('/video/series/'.length).split('/').map(decodeURIComponent);
    const episode = parts.length === 3 && findEpisode(parts[0], parseInt(parts[1], 10), parseInt(parts[2], 10));
    if (!episode) { res.writeHead(404); return res.end('No encontrado'); }
    const mime = MIME_TYPES[path.extname(episode.videoFile).toLowerCase()] || 'application/octet-stream';
    try { return streamFile(req, res, episode.videoFile, mime); }
    catch (e) { res.writeHead(500); return res.end('Error leyendo el archivo'); }
  }

  if (url.pathname.startsWith('/video/')) {
    const id = decodeURIComponent(url.pathname.slice('/video/'.length));
    const movie = findMovie(id);
    if (!movie) { res.writeHead(404); return res.end('No encontrado'); }
    const mime = MIME_TYPES[path.extname(movie.videoFile).toLowerCase()] || 'application/octet-stream';
    try { return streamFile(req, res, movie.videoFile, mime); }
    catch (e) { res.writeHead(500); return res.end('Error leyendo el archivo'); }
  }

  const seriesCacheMatch = url.pathname.match(/^\/cache\/series\/([^/]+)\/(poster|backdrop)$/);
  if (seriesCacheMatch) {
    const id = decodeURIComponent(seriesCacheMatch[1]);
    const kind = seriesCacheMatch[2];
    const show = findShow(id);
    const file = show && (kind === 'poster' ? (show.localPosterFile || show.posterCacheFile) : show.backdropCacheFile);
    if (!file) { res.writeHead(404); return res.end('No encontrado'); }
    const mime = MIME_TYPES[path.extname(file).toLowerCase()] || 'image/jpeg';
    try { return streamFile(req, res, file, mime); }
    catch (e) { res.writeHead(500); return res.end('Error leyendo el archivo'); }
  }

  const cacheMatch = url.pathname.match(/^\/cache\/([^/]+)\/(poster|backdrop)$/);
  if (cacheMatch) {
    const id = decodeURIComponent(cacheMatch[1]);
    const kind = cacheMatch[2];
    const movie = findMovie(id);
    const file = movie && (kind === 'poster' ? (movie.localPosterFile || movie.posterCacheFile) : movie.backdropCacheFile);
    if (!file) { res.writeHead(404); return res.end('No encontrado'); }
    const mime = MIME_TYPES[path.extname(file).toLowerCase()] || 'image/jpeg';
    try { return streamFile(req, res, file, mime); }
    catch (e) { res.writeHead(500); return res.end('Error leyendo el archivo'); }
  }

  serveStatic(res, url.pathname);
});

async function main() {
  if (!MOVIES_DIR) console.log(`Aviso: no se ha encontrado la subcarpeta "Peliculas" dentro de ${ROOT_DIR}`);
  if (!SERIES_DIR) console.log(`Aviso: no se ha encontrado la subcarpeta "Series" dentro de ${ROOT_DIR}`);

  fs.rmSync(CACHE_DIR, { recursive: true, force: true });
  fs.mkdirSync(SERIES_CACHE_DIR, { recursive: true }); // crea también CACHE_DIR, su padre

  library = await buildLibrary();
  seriesLibrary = await buildSeriesLibrary();

  server.listen(PORT, () => {
    const nets = os.networkInterfaces();
    const ips = [];
    for (const name of Object.keys(nets)) {
      for (const net of nets[name]) {
        if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
      }
    }
    console.log(`\nServidor de Nextfilm escuchando en el puerto ${PORT}`);
    console.log(`Carpeta raíz: ${ROOT_DIR}`);
    if (ips.length) {
      console.log('\nPon una de estas direcciones en Ajustes (⚙) de la app, o en CONFIG.SERVER_URL de js/app.js:');
      ips.forEach(ip => console.log(`  http://${ip}:${PORT}`));
    } else {
      console.log('No se detectó ninguna IP de red local (¿estás conectado a la red?).');
    }
    console.log(`\nPara probarlo en este PC, abre: http://localhost:${PORT}/ (modo "elegir carpeta") o http://localhost:${PORT}/?server=1 (modo "tele").`);
  });
}

main();
