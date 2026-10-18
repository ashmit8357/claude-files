const mysql = require('mysql2/promise');
const { dbConfig, missingEnv } = require('./db');

/*
 * Safe to run any number of times.
 *   node setup-db.js                          create / upgrade tables and (re)create the Zoho views
 *   node setup-db.js --fix-data               also turn skipped answers into NULL and remove stale rows
 *   node setup-db.js --mark-existing-as-test  flag every row already in the DB as test data
 *                                             (run once, before real responses arrive)
 */
const FIX_DATA = process.argv.includes('--fix-data');
const MARK_TEST = process.argv.includes('--mark-existing-as-test');

const BAYES_M = 5;         // votes a title needs before its own average outweighs the overall average
const MIN_PAIR_COUNT = 3;  // genre pairs seen fewer times than this are hidden from the lift view

const ANIME = `('Anime only','Both')`;
const MOVIES = `('Movies and shows only','Both')`;

async function hasColumn(c, table, column) {
  const [rows] = await c.query(
    `SELECT COUNT(*) AS n FROM information_schema.columns
     WHERE table_schema = DATABASE() AND table_name = ? AND column_name = ?`, [table, column]);
  return rows[0].n > 0;
}

/* ---------------- 1. Tables ---------------- */
async function createTables(c) {
  await c.query(`
    CREATE TABLE IF NOT EXISTS respondents (
      RespondentID INT AUTO_INCREMENT PRIMARY KEY,
      Role VARCHAR(20) NOT NULL,
      YearOfStudy VARCHAR(20) NULL,
      AgeGroup VARCHAR(20) NOT NULL,
      Gender VARCHAR(30) NULL,
      WatchType VARCHAR(30) NOT NULL,
      AnimeHours DECIMAL(5,1) NULL,
      MovieHours DECIMAL(5,1) NULL,
      FormatPref VARCHAR(20) NULL,
      MediumPref VARCHAR(20) NOT NULL,
      Consent TINYINT(1) NOT NULL,
      IsTest TINYINT(1) NOT NULL DEFAULT 0,
      PersonaID INT NULL,
      SubmittedAt TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS genre_watched (
      RespondentID INT NOT NULL,
      Medium VARCHAR(10) NOT NULL,
      Genre VARCHAR(50) NOT NULL,
      PRIMARY KEY (RespondentID, Medium, Genre),
      FOREIGN KEY (RespondentID) REFERENCES respondents(RespondentID) ON DELETE CASCADE
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS tone_rating (
      RespondentID INT NOT NULL,
      Medium VARCHAR(10) NOT NULL,
      Tone VARCHAR(20) NOT NULL,
      Score TINYINT NOT NULL CHECK (Score BETWEEN 1 AND 5),
      PRIMARY KEY (RespondentID, Medium, Tone),
      FOREIGN KEY (RespondentID) REFERENCES respondents(RespondentID) ON DELETE CASCADE
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS favorite_title (
      RespondentID INT NOT NULL,
      Source VARCHAR(10) NOT NULL,
      MediaType VARCHAR(10) NOT NULL,
      TitleID INT NOT NULL,
      TitleName VARCHAR(255) NOT NULL,
      Rating TINYINT NOT NULL CHECK (Rating BETWEEN 1 AND 5),
      PRIMARY KEY (RespondentID, Source, MediaType, TitleID),
      FOREIGN KEY (RespondentID) REFERENCES respondents(RespondentID) ON DELETE CASCADE
    )`);
  await c.query(`
    CREATE TABLE IF NOT EXISTS watch_driver (
      RespondentID INT NOT NULL,
      Driver VARCHAR(30) NOT NULL,
      PRIMARY KEY (RespondentID, Driver),
      FOREIGN KEY (RespondentID) REFERENCES respondents(RespondentID) ON DELETE CASCADE
    )`);
}

/* Brings a database created by the older setup script up to date. */
async function upgradeTables(c) {
  if (!(await hasColumn(c, 'respondents', 'IsTest'))) {
    await c.query(`ALTER TABLE respondents ADD COLUMN IsTest TINYINT(1) NOT NULL DEFAULT 0 AFTER Consent`);
    console.log('  + respondents.IsTest');
  }
  if (!(await hasColumn(c, 'respondents', 'PersonaID'))) {
    await c.query(`ALTER TABLE respondents ADD COLUMN PersonaID INT NULL AFTER IsTest`);
    console.log('  + respondents.PersonaID');
  }
  if (!(await hasColumn(c, 'favorite_title', 'MediaType'))) {
    // TMDB ids can repeat between a movie and a TV show, so the type becomes part of the key.
    await c.query(`
      ALTER TABLE favorite_title
        ADD COLUMN MediaType VARCHAR(10) NOT NULL DEFAULT 'unknown' AFTER Source,
        DROP PRIMARY KEY,
        ADD PRIMARY KEY (RespondentID, Source, MediaType, TitleID)`);
    await c.query(`UPDATE favorite_title SET MediaType = 'anime' WHERE Source = 'AniList'`);
    console.log("  + favorite_title.MediaType (older TMDB rows stay 'unknown')");
  }
}

/* ---------------- 2. Optional data fixes ---------------- */
async function markExistingAsTest(c) {
  const [r] = await c.query(`UPDATE respondents SET IsTest = 1 WHERE IsTest = 0`);
  console.log(`  ${r.affectedRows} existing respondent(s) flagged as test data`);
}

async function fixData(c) {
  const steps = [
    ['anime hours on respondents who were never asked',
      `UPDATE respondents SET AnimeHours = NULL WHERE WatchType NOT IN ${ANIME} AND AnimeHours IS NOT NULL`],
    ['movie hours on respondents who were never asked',
      `UPDATE respondents SET MovieHours = NULL WHERE WatchType NOT IN ${MOVIES} AND MovieHours IS NOT NULL`],
    ['format preference on respondents who were never asked',
      `UPDATE respondents SET FormatPref = NULL WHERE WatchType NOT IN ${MOVIES} AND FormatPref IS NOT NULL`],
    ['stale anime genres',
      `DELETE x FROM genre_watched x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Medium = 'Anime' AND r.WatchType NOT IN ${ANIME}`],
    ['stale movie genres',
      `DELETE x FROM genre_watched x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Medium = 'Movie' AND r.WatchType NOT IN ${MOVIES}`],
    ['stale anime tone ratings',
      `DELETE x FROM tone_rating x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Medium = 'Anime' AND r.WatchType NOT IN ${ANIME}`],
    ['stale movie tone ratings',
      `DELETE x FROM tone_rating x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Medium = 'Movie' AND r.WatchType NOT IN ${MOVIES}`],
    ['stale anime favorites',
      `DELETE x FROM favorite_title x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Source = 'AniList' AND r.WatchType NOT IN ${ANIME}`],
    ['stale movie favorites',
      `DELETE x FROM favorite_title x JOIN respondents r ON r.RespondentID = x.RespondentID WHERE x.Source = 'TMDB' AND r.WatchType NOT IN ${MOVIES}`]
  ];
  for (const [label, sql] of steps) {
    const [r] = await c.query(sql);
    console.log(`  ${r.affectedRows} row(s): ${label}`);
  }
}

/* ---------------- 3. Views for Zoho Analytics ----------------
 * Fact views are one row per answer and carry the same filter columns
 * (Gender, AgeGroup, YearOfStudy, WatchType, MediumPref, PersonaID), so Zoho can aggregate and
 * filter them. Only the two computed views (pair lift, title rating) are pre-aggregated.
 * Every view hides test rows and rows without consent. */
const REAL = `r.IsTest = 0 AND r.Consent = 1`;
const DIM = `r.Gender, r.AgeGroup, r.YearOfStudy, r.WatchType, r.MediumPref, r.PersonaID`;

const VIEWS = {
  vw_respondents: `
    SELECT r.RespondentID, r.Role, r.YearOfStudy, r.AgeGroup, r.Gender, r.WatchType, r.MediumPref, r.FormatPref,
           r.AnimeHours, r.MovieHours, r.PersonaID, DATE(r.SubmittedAt) AS SubmittedDate
    FROM respondents r
    WHERE ${REAL}`,

  vw_hours_both: `
    SELECT r.RespondentID, ${DIM}, r.AnimeHours, r.MovieHours
    FROM respondents r
    WHERE ${REAL} AND r.WatchType = 'Both'`,

  vw_genre_fact: `
    SELECT x.RespondentID, x.Medium, x.Genre, ${DIM}
    FROM genre_watched x JOIN respondents r ON r.RespondentID = x.RespondentID
    WHERE ${REAL}`,

  vw_tone_fact: `
    SELECT x.RespondentID, x.Medium, x.Tone, x.Score, ${DIM}
    FROM tone_rating x JOIN respondents r ON r.RespondentID = x.RespondentID
    WHERE ${REAL}`,

  vw_title_fact: `
    SELECT x.RespondentID, x.Source, x.MediaType, x.TitleID, x.TitleName, x.Rating, ${DIM}
    FROM favorite_title x JOIN respondents r ON r.RespondentID = x.RespondentID
    WHERE ${REAL}`,

  vw_driver_fact: `
    SELECT x.RespondentID, x.Driver, ${DIM}
    FROM watch_driver x JOIN respondents r ON r.RespondentID = x.RespondentID
    WHERE ${REAL}`,

  // Genre pairs that the same respondent picked within the same medium (lift matrix, co-viewing bars).
  vw_genre_pair_lift: `
    WITH base AS (
      SELECT x.RespondentID, x.Medium, x.Genre
      FROM genre_watched x JOIN respondents r ON r.RespondentID = x.RespondentID
      WHERE ${REAL}
    ),
    med  AS (SELECT Medium, COUNT(DISTINCT RespondentID) AS Total FROM base GROUP BY Medium),
    solo AS (SELECT Medium, Genre, COUNT(*) AS Cnt FROM base GROUP BY Medium, Genre),
    duo  AS (
      SELECT a.Medium, a.Genre AS GenreA, b.Genre AS GenreB, COUNT(*) AS PairCount
      FROM base a JOIN base b
        ON b.RespondentID = a.RespondentID AND b.Medium = a.Medium AND a.Genre < b.Genre
      GROUP BY a.Medium, a.Genre, b.Genre
    )
    SELECT d.Medium, d.GenreA, d.GenreB, d.PairCount, m.Total AS MediumRespondents,
           ROUND(d.PairCount / m.Total, 4) AS Support,
           ROUND(d.PairCount / sa.Cnt, 4) AS ConfidenceAtoB,
           ROUND((d.PairCount * m.Total) / (sa.Cnt * sb.Cnt), 3) AS Lift
    FROM duo d
    JOIN med  m  ON m.Medium = d.Medium
    JOIN solo sa ON sa.Medium = d.Medium AND sa.Genre = d.GenreA
    JOIN solo sb ON sb.Medium = d.Medium AND sb.Genre = d.GenreB
    WHERE d.PairCount >= ${MIN_PAIR_COUNT}`,

  // Bayesian weighted rating: titles with few votes are pulled toward the average for their source.
  vw_title_rating: `
    WITH t AS (
      SELECT x.Source, x.MediaType, x.TitleID, x.TitleName, x.Rating
      FROM favorite_title x JOIN respondents r ON r.RespondentID = x.RespondentID
      WHERE ${REAL}
    ),
    prior AS (SELECT Source, AVG(Rating) AS GlobalAvg FROM t GROUP BY Source),
    s AS (
      SELECT Source, MediaType, TitleID, MAX(TitleName) AS TitleName, COUNT(*) AS Votes, AVG(Rating) AS RawAvg
      FROM t GROUP BY Source, MediaType, TitleID
    )
    SELECT s.Source, s.MediaType, s.TitleID, s.TitleName, s.Votes,
           ROUND(s.RawAvg, 2) AS RawAvg,
           ROUND((s.Votes * s.RawAvg + ${BAYES_M} * p.GlobalAvg) / (s.Votes + ${BAYES_M}), 3) AS WeightedRating
    FROM s JOIN prior p ON p.Source = s.Source`
};

async function createViews(c) {
  for (const [name, body] of Object.entries(VIEWS)) {
    await c.query(`CREATE OR REPLACE VIEW ${name} AS ${body}`);
    console.log(`  view ${name}`);
  }
}

/* ---------------- 4. Health report ---------------- */
async function report(c) {
  const [[counts]] = await c.query(`
    SELECT (SELECT COUNT(*) FROM respondents) AS respondents,
           (SELECT COUNT(*) FROM respondents WHERE IsTest = 1) AS test_rows,
           (SELECT COUNT(*) FROM genre_watched) AS genre_rows,
           (SELECT COUNT(*) FROM tone_rating) AS tone_rows,
           (SELECT COUNT(*) FROM favorite_title) AS favorite_rows,
           (SELECT COUNT(*) FROM watch_driver) AS driver_rows`);
  const [[issues]] = await c.query(`
    SELECT
      (SELECT COUNT(*) FROM respondents
        WHERE (WatchType NOT IN ${ANIME} AND AnimeHours IS NOT NULL)
           OR (WatchType NOT IN ${MOVIES} AND (MovieHours IS NOT NULL OR FormatPref IS NOT NULL))) AS skipped_but_filled,
      (SELECT COUNT(*) FROM respondents
        WHERE (WatchType IN ${ANIME} AND AnimeHours IS NULL)
           OR (WatchType IN ${MOVIES} AND (MovieHours IS NULL OR FormatPref IS NULL))) AS asked_but_empty,
      (SELECT COUNT(*) FROM genre_watched x JOIN respondents r ON r.RespondentID = x.RespondentID
        WHERE (x.Medium = 'Anime' AND r.WatchType NOT IN ${ANIME}) OR (x.Medium = 'Movie' AND r.WatchType NOT IN ${MOVIES})) AS stale_genre_rows,
      (SELECT COUNT(*) FROM tone_rating x JOIN respondents r ON r.RespondentID = x.RespondentID
        WHERE (x.Medium = 'Anime' AND r.WatchType NOT IN ${ANIME}) OR (x.Medium = 'Movie' AND r.WatchType NOT IN ${MOVIES})) AS stale_tone_rows,
      (SELECT COUNT(*) FROM favorite_title x JOIN respondents r ON r.RespondentID = x.RespondentID
        WHERE (x.Source = 'AniList' AND r.WatchType NOT IN ${ANIME}) OR (x.Source = 'TMDB' AND r.WatchType NOT IN ${MOVIES})) AS stale_favorite_rows,
      (SELECT COUNT(*) FROM respondents r
        WHERE NOT EXISTS (SELECT 1 FROM watch_driver d WHERE d.RespondentID = r.RespondentID)) AS missing_drivers`);
  console.log('\nRow counts:');
  console.table([counts]);
  console.log('Consistency checks (all should be 0; missing_drivers > 0 is expected for submissions made before this update):');
  console.table([issues]);
}

/* ---------------- run ---------------- */
(async () => {
  const missing = missingEnv();
  if (missing.length) {
    console.error(`Missing environment variables: ${missing.join(', ')}`);
    process.exit(1);
  }
  const c = await mysql.createConnection(dbConfig());
  try {
    console.log('Tables:');
    await createTables(c);
    await upgradeTables(c);
    if (MARK_TEST) { console.log('Test flag:'); await markExistingAsTest(c); }
    if (FIX_DATA) { console.log('Data fixes:'); await fixData(c); }
    else console.log('Data fixes skipped (add --fix-data to apply them).');
    console.log('Views:');
    await createViews(c);
    await report(c);
    console.log('Done.');
  } catch (e) {
    console.error('Setup failed:', e.message);
    process.exitCode = 1;
  } finally {
    await c.end();
  }
})();
