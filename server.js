const express = require('express');
const cors = require('cors');
const mysql = require('mysql2/promise');
const { dbConfig, missingEnv } = require('./db');

if (require.main === module && missingEnv().length) {
  console.error(`Missing environment variables: ${missingEnv().join(', ')}`);
  process.exit(1);
}

const app = express();

const pool = mysql.createPool({
  ...dbConfig(),
  waitForConnections: true,
  connectionLimit: 10,
  enableKeepAlive: true,      // Aiven drops idle connections; keep-alive avoids "connection lost" errors
  keepAliveInitialDelay: 10000
});

// CORS: set ALLOWED_ORIGINS on Render (comma-separated, e.g. https://your-form-site.com) to lock the API to your form.
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
if (!allowedOrigins.length) console.warn('[cors] ALLOWED_ORIGINS not set: any website can call this API.');
app.use(cors(allowedOrigins.length
  ? { origin: (origin, cb) => cb(null, !origin || allowedOrigins.includes(origin)) }
  : {}));
app.use(express.json({ limit: '50kb' }));

/* ------------------------------------------------------------------ *
 * Allowed answer values. Keep these in sync with the DB array in index.html.
 * ------------------------------------------------------------------ */
const ALLOWED = {
  year: ['1st', '2nd', '3rd', '4th', 'pass out', 'Others'],
  age: ['Under 18', '18\u201320', '21\u201323', '24+'],
  gender: ['Male', 'Female', 'Other', 'Prefer not to say'],
  watchType: ['Anime only', 'Movies and shows only', 'Both', 'Neither'],
  formatPref: ['Movies', 'Series', 'Both'],
  mediumPref: ['Anime', 'Movies', 'Shows', 'Both'],
  animeGenres: ['Action', 'Adventure', 'Comedy', 'Drama', 'Fantasy', 'Horror', 'Mystery', 'Psychological', 'Romance', 'Sci-Fi', 'Slice of Life', 'Sports', 'Thriller', 'Shonen', 'Isekai'],
  movieGenres: ['Action', 'Comedy', 'Drama', 'Horror', 'Romance', 'Sci-Fi', 'Thriller', 'Documentary', 'Animation'],
  tones: ['Light', 'Dark', 'Emotional', 'Comedic'],
  drivers: ['Story', 'Characters', 'Animation or visuals', 'Humor', 'Emotion', 'Pacing', 'Length']
};

/* ------------------------------------------------------------------ *
 * Validation. Anything the form skipped stays NULL (never 0), so
 * AVG(AnimeHours) in Zoho only averages people who were actually asked.
 * ------------------------------------------------------------------ */
class ValidationError extends Error {}
const fail = msg => { throw new ValidationError(msg); };
const oneOf = (v, list, label) => (list.includes(v) ? v : fail(`Invalid ${label}.`));
const toNum = v => (v === undefined || v === null || String(v).trim() === '' ? NaN : Number(v));
const wholeNumber = (v, min, max, label) => {
  const n = toNum(v);
  return Number.isInteger(n) && n >= min && n <= max ? n : fail(`${label} must be a whole number from ${min} to ${max}.`);
};
const hoursValue = (v, label) => {
  const n = toNum(v);
  return Number.isFinite(n) && n >= 0 && n <= 744 ? Math.round(n * 10) / 10 : fail(`${label} must be between 0 and 744.`);
};

function parseGenres(medium, list, allowed) {
  if (!Array.isArray(list) || list.length === 0) fail(`Pick at least one ${medium.toLowerCase()} genre.`);
  return [...new Set(list)].map(g => ({ medium, genre: oneOf(g, allowed, `${medium.toLowerCase()} genre`) }));
}

function parseTones(medium, tones) {
  if (!tones || typeof tones !== 'object') fail(`Rate all ${medium.toLowerCase()} tones.`);
  return ALLOWED.tones.map(tone => ({ medium, tone, score: wholeNumber(tones[tone], 1, 5, `${medium} ${tone} tone rating`) }));
}

function parseFavs(source, list) {
  if (!Array.isArray(list) || list.length === 0) fail('Pick at least one favorite title.');
  if (list.length > 3) fail('Pick at most 3 favorite titles.');
  const seen = new Set();
  const rows = [];
  for (const t of list) {
    const item = t || {};
    const id = wholeNumber(item.id, 1, 2147483647, 'Title id');
    const title = String(item.title || '').trim().slice(0, 255);
    if (!title) fail('A selected title has no name.');
    // AniList is always anime; TMDB ids can repeat between movies and TV, so the type is part of the key.
    const mediaType = source === 'AniList' ? 'anime' : (item.type === 'tv' ? 'tv' : 'movie');
    const key = `${mediaType}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push({ source, mediaType, id, title, rating: wholeNumber(item.rating, 1, 5, 'Title rating') });
  }
  return rows;
}

function validateSurvey(b) {
  if (!b || typeof b !== 'object') fail('Invalid request.');
  if (!b.consent) fail('Consent is required.');

  const year = oneOf(b.year, ALLOWED.year, 'year of study');
  const watchType = oneOf(b.watch_type, ALLOWED.watchType, 'watch type');
  const wantsAnime = ['Anime only', 'Both'].includes(watchType);
  const wantsMovies = ['Movies and shows only', 'Both'].includes(watchType);

  const out = {
    role: ['Others', 'pass out'].includes(year) ? 'Other' : 'Student',
    year,
    age: oneOf(b.age, ALLOWED.age, 'age group'),
    gender: oneOf(b.gender, ALLOWED.gender, 'gender'),
    watchType,
    mediumPref: oneOf(b.medium_pref, ALLOWED.mediumPref, 'medium preference'),
    animeHours: null, movieHours: null, formatPref: null,
    genres: [], tones: [], favs: [], drivers: [],
    isTest: b.is_test === true
  };

  if (wantsAnime) {
    out.animeHours = hoursValue(b.anime_hours, 'Anime hours');
    out.genres.push(...parseGenres('Anime', b.anime_genres, ALLOWED.animeGenres));
    out.tones.push(...parseTones('Anime', b.anime_tones));
    out.favs.push(...parseFavs('AniList', b.anime_favs));
  }
  if (wantsMovies) {
    out.movieHours = hoursValue(b.movie_hours, 'Movie hours');
    out.formatPref = oneOf(b.format_pref, ALLOWED.formatPref, 'format preference');
    out.genres.push(...parseGenres('Movie', b.movie_genres, ALLOWED.movieGenres));
    out.tones.push(...parseTones('Movie', b.movie_tones));
    out.favs.push(...parseFavs('TMDB', b.movie_favs));
  }

  if (!Array.isArray(b.dealbreakers) || b.dealbreakers.length < 1 || b.dealbreakers.length > 2) {
    fail('Pick 1 or 2 things that keep you watching.');
  }
  out.drivers = [...new Set(b.dealbreakers)].map(d => oneOf(d, ALLOWED.drivers, 'watch driver'));
  return out;
}

/* ------------------------------------------------------------------ *
 * Routes
 * ------------------------------------------------------------------ */
app.post('/api/submit-survey', async (req, res) => {
  let conn;
  try {
    const s = validateSurvey(req.body);

    conn = await pool.getConnection();
    await conn.beginTransaction();

    const [ins] = await conn.execute(
      `INSERT INTO respondents
        (Role, YearOfStudy, AgeGroup, Gender, WatchType, AnimeHours, MovieHours, FormatPref, MediumPref, Consent, IsTest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      [s.role, s.year, s.age, s.gender, s.watchType, s.animeHours, s.movieHours, s.formatPref, s.mediumPref, s.isTest ? 1 : 0]
    );
    const id = ins.insertId;

    if (s.genres.length) {
      await conn.query('INSERT INTO genre_watched (RespondentID, Medium, Genre) VALUES ?',
        [s.genres.map(g => [id, g.medium, g.genre])]);
    }
    if (s.tones.length) {
      await conn.query('INSERT INTO tone_rating (RespondentID, Medium, Tone, Score) VALUES ?',
        [s.tones.map(t => [id, t.medium, t.tone, t.score])]);
    }
    if (s.favs.length) {
      await conn.query('INSERT INTO favorite_title (RespondentID, Source, MediaType, TitleID, TitleName, Rating) VALUES ?',
        [s.favs.map(f => [id, f.source, f.mediaType, f.id, f.title, f.rating])]);
    }
    await conn.query('INSERT INTO watch_driver (RespondentID, Driver) VALUES ?',
      [s.drivers.map(d => [id, d])]);

    await conn.commit();
    res.status(200).json({ message: 'Success', respondentId: id });
  } catch (err) {
    if (conn) { try { await conn.rollback(); } catch (_) { /* connection already gone */ } }
    if (err instanceof ValidationError) return res.status(400).json({ error: err.message });
    console.error('Transaction error:', err);
    res.status(500).json({ error: 'Database transaction failed.' });
  } finally {
    if (conn) conn.release();
  }
});

// TMDB search runs here so the TMDB key lives in Render's env vars instead of the public page.
app.get('/api/tmdb-search', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2 || q.length > 100) return res.json([]);
  if (!process.env.TMDB_API_KEY) return res.status(500).json({ error: 'Search is not configured.' });
  try {
    const url = `https://api.themoviedb.org/3/search/multi?api_key=${encodeURIComponent(process.env.TMDB_API_KEY)}&query=${encodeURIComponent(q)}`;
    const r = await fetch(url);
    if (!r.ok) return res.status(502).json({ error: 'Search failed.' });
    const json = await r.json();
    res.json((json.results || [])
      .filter(m => m.media_type === 'movie' || m.media_type === 'tv')
      .slice(0, 6)
      .map(m => ({
        id: m.id,
        title: m.title || m.name,
        type: m.media_type,
        img: m.poster_path ? `https://image.tmdb.org/t/p/w200${m.poster_path}` : null
      })));
  } catch (err) {
    console.error('TMDB error:', err.message);
    res.status(502).json({ error: 'Search failed.' });
  }
});

app.get('/health', (req, res) => res.json({ status: 'ok' }));
app.get('/health/db', async (req, res) => {
  try { await pool.query('SELECT 1'); res.json({ status: 'ok' }); }
  catch (e) { res.status(503).json({ status: 'db_unreachable' }); }
});

app.use((err, req, res, next) => { // bad JSON / oversized body
  if (err.type === 'entity.parse.failed' || err.type === 'entity.too.large') return res.status(400).json({ error: 'Invalid request.' });
  console.error(err);
  res.status(500).json({ error: 'Server error.' });
});

process.on('unhandledRejection', err => console.error('Unhandled rejection:', err));

/* ------------------------------------------------------------------ *
 * Startup: refuse to run against an outdated schema (otherwise every
 * submission would fail and the dashboard would stay empty).
 * ------------------------------------------------------------------ */
async function checkSchema() {
  try {
    const [[r]] = await pool.query(`
      SELECT
        (SELECT COUNT(*) FROM information_schema.tables  WHERE table_schema = DATABASE() AND table_name = 'watch_driver') AS hasDriver,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'respondents' AND column_name = 'IsTest') AS hasIsTest,
        (SELECT COUNT(*) FROM information_schema.columns WHERE table_schema = DATABASE() AND table_name = 'favorite_title' AND column_name = 'MediaType') AS hasMediaType`);
    if (!r.hasDriver || !r.hasIsTest || !r.hasMediaType) {
      console.error('Database schema is out of date. Run "node setup-db.js" first, then restart.');
      process.exit(1);
    }
  } catch (e) {
    console.warn('Could not verify the database schema at startup:', e.message);
  }
}

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  checkSchema().then(() => app.listen(PORT, () => console.log(`Server running on port ${PORT}`)));
}

module.exports = { app, validateSurvey };
