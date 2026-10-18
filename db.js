require('dotenv').config();

// TLS: in the Aiven console (your MySQL service > Overview) copy the "CA certificate" and put its text in the
// DB_CA_CERT env var (newlines may be written as \n). With it set, the server certificate is fully verified.
function sslConfig() {
  if (process.env.DB_SSL === 'off') return undefined; // local development only
  const ca = process.env.DB_CA_CERT;
  if (ca) return { ca: ca.replace(/\\n/g, '\n'), rejectUnauthorized: true };
  console.warn('[db] DB_CA_CERT not set: connection is encrypted but the server certificate is NOT verified.');
  return { rejectUnauthorized: false };
}

function dbConfig() {
  return {
    host: process.env.DB_HOST,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
    port: Number(process.env.DB_PORT) || 25060,
    ssl: sslConfig(),
    connectTimeout: 10000
  };
}

function missingEnv() {
  return ['DB_HOST', 'DB_USER', 'DB_PASSWORD', 'DB_NAME'].filter(k => !process.env[k]);
}

module.exports = { dbConfig, missingEnv };
