#!/usr/bin/env node
/**
 * TORI Download Manager — Safe Close-to-Tray Recovery Utility
 *
 * Explicitly enables `closeToTray: true` inside the `app_settings` JSON row
 * of `tdm_storage.sqlite` without resetting or modifying any other user settings
 * (theme, accent, download directory, concurrency, speed limits, etc.).
 *
 * Usage:
 *   1. Against an isolated or custom database path:
 *      node scripts/enable_close_to_tray.js --db "path/to/tdm_storage.sqlite"
 *
 *   2. Against the installed user profile database (requires explicit flag):
 *      node scripts/enable_close_to_tray.js --confirm-production
 *
 *   Alternatively, launch the TORI desktop binary once with:
 *      tori-download-manager.exe --enable-close-to-tray
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseArgs() {
  const args = process.argv.slice(2);
  let dbPath = null;
  let confirmProduction = false;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--db' && args[i + 1]) {
      dbPath = path.resolve(args[++i]);
    } else if (args[i] === '--confirm-production') {
      confirmProduction = true;
    }
  }

  return { dbPath, confirmProduction };
}

function main() {
  const { dbPath, confirmProduction } = parseArgs();

  let targetDb = dbPath;
  if (!targetDb) {
    if (!confirmProduction) {
      console.error(
        'Usage:\n' +
          '  node scripts/enable_close_to_tray.js --db <path-to-tdm_storage.sqlite>\n' +
          '  node scripts/enable_close_to_tray.js --confirm-production\n\n' +
          'Refusing to touch production SQLite database without explicit --confirm-production flag.'
      );
      process.exit(1);
    }
    const appData = process.env.APPDATA;
    if (!appData) {
      console.error('APPDATA environment variable is not set.');
      process.exit(1);
    }
    targetDb = path.join(appData, 'tori-download-manager', 'tdm_storage.sqlite');
  }

  if (!fs.existsSync(targetDb)) {
    console.error(`Database file not found: ${targetDb}`);
    process.exit(1);
  }

  const pyScript = `
import sqlite3, json, sys
db_path = sys.argv[1]
conn = sqlite3.connect(db_path, timeout=5.0)
cur = conn.cursor()
cur.execute("CREATE TABLE IF NOT EXISTS engine_settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
cur.execute("SELECT value FROM engine_settings WHERE key = 'app_settings'")
row = cur.fetchone()
if row and row[0]:
    data = json.loads(row[0])
else:
    data = {}
before = data.get("closeToTray", None)
data["closeToTray"] = True
serialized = json.dumps(data, separators=(',', ':'))
cur.execute(
    "INSERT INTO engine_settings (key, value) VALUES ('app_settings', ?) "
    "ON CONFLICT(key) DO UPDATE SET value = excluded.value",
    (serialized,)
)
conn.commit()
conn.close()
print(json.dumps({"db": db_path, "before": before, "after": data["closeToTray"], "preservedKeys": list(data.keys())}))
`;

  const out = execFileSync('python', ['-c', pyScript, targetDb], { encoding: 'utf8' });
  console.log('[OK] Close-to-Tray enabled safely:', out.trim());
}

main();

