#!/usr/bin/env node
/**
 * TORI Download Manager — Shared QA OEM Host-State Isolation Guard (Gate 31.5)
 *
 * Prevents isolated NSIS / Native Messaging QA scripts from permanently mutating
 * production Windows Registry keys, Native Messaging manifests, shortcuts, or
 * running OEM Desktop processes.
 *
 * Key invariants:
 *  1. Backup directory is stored strictly OUTSIDE any QA_ROOT (`target/_oem_state_backups/...`)
 *     so deleting QA_ROOT can never destroy OEM recovery artifacts.
 *  2. Fails closed if backup creation fails for any existing key or manifest.
 *  3. Restores HKCU\Software\tori\TORI Download Manager, Uninstall\TORI Download Manager,
 *     Chrome/Edge/Firefox NativeMessagingHosts, %APPDATA% manifests, shortcuts, and OEM process.
 *  4. Verifies exact post-restore registry & manifest parity.
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');

const DEFAULT_ALLOWED_VOLATILE_SETTING_KEYS = ['last_extension_ping', 'active_server_port'];

/**
 * Captures a logical, WAL-safe, read-only SQLite snapshot of the production TORI database
 * plus SHA-256 digests of all existing `.tdm-part` partial download files referenced by rows.
 *
 * Why: Raw `.sqlite` file byte hashes can legitimately change under SQLite WAL checkpoints
 * or volatile live-browser heartbeat writes (`last_extension_ping`, `active_server_port`)
 * while zero user downloads, chunks, protected settings, or `.tdm-part` files change.
 */
function snapshotOemDatabase(dbPath, { allowedVolatileKeys = DEFAULT_ALLOWED_VOLATILE_SETTING_KEYS } = {}) {
  if (!dbPath || !fs.existsSync(dbPath)) {
    return {
      exists: false,
      integrityOk: false,
      rawFileSha256: null,
      downloadsCount: 0,
      chunksCount: 0,
      downloadsHash: null,
      chunksHash: null,
      protectedSettingsHash: null,
      volatileSettings: {},
      partFilesCount: 0,
      partFilesHash: null,
    };
  }

  const pyScript = `
import hashlib, json, os, sqlite3, sys
from urllib.request import pathname2url

db_path = sys.argv[1]
volatile_keys = set(json.loads(sys.argv[2]))
uri = "file:" + pathname2url(os.path.abspath(db_path)) + "?mode=ro"
con = sqlite3.connect(uri, uri=True, timeout=5.0)
cur = con.cursor()

integrity = [r[0] for r in cur.execute("PRAGMA integrity_check").fetchall()]
integrity_ok = (integrity == ["ok"])

def canonical_hash(rows):
    payload = json.dumps(rows, sort_keys=True, separators=(",", ":"), default=str).encode("utf-8")
    return hashlib.sha256(payload).hexdigest()

tables = {r[0] for r in cur.execute("SELECT name FROM sqlite_master WHERE type='table'").fetchall()}

downloads_rows = []
if "downloads" in tables:
    cols = [r[1] for r in cur.execute("PRAGMA table_info(downloads)").fetchall()]
    order_col = "id" if "id" in cols else "rowid"
    downloads_rows = [list(r) for r in cur.execute(f"SELECT * FROM downloads ORDER BY {order_col}").fetchall()]

chunks_rows = []
if "download_chunks" in tables:
    cols = [r[1] for r in cur.execute("PRAGMA table_info(download_chunks)").fetchall()]
    order_cols = ", ".join([c for c in ("job_id", "chunk_index", "id") if c in cols]) or "rowid"
    chunks_rows = [list(r) for r in cur.execute(f"SELECT * FROM download_chunks ORDER BY {order_cols}").fetchall()]

protected_settings = []
volatile_settings = {}
if "engine_settings" in tables:
    for k, v in cur.execute("SELECT key, value FROM engine_settings ORDER BY key").fetchall():
        if k in volatile_keys:
            volatile_settings[k] = v
        else:
            protected_settings.append([k, v])

# Hash all existing .tdm-part files referenced by download rows
part_files = []
if "downloads" in tables:
    dcols = [r[1] for r in cur.execute("PRAGMA table_info(downloads)").fetchall()]
    tp_idx = dcols.index("target_path") if "target_path" in dcols else -1
    seen_parts = set()
    if tp_idx >= 0:
        for row in downloads_rows:
            tp = row[tp_idx]
            if not tp:
                continue
            cand = tp if str(tp).endswith(".tdm-part") else (str(tp) + ".tdm-part")
            if cand in seen_parts or not os.path.isfile(cand):
                continue
            seen_parts.add(cand)
            h = hashlib.sha256()
            with open(cand, "rb") as f:
                while True:
                    b = f.read(65536)
                    if not b:
                        break
                    h.update(b)
            part_files.append([os.path.normcase(cand), os.path.getsize(cand), h.hexdigest()])
part_files.sort(key=lambda x: x[0])

con.close()

raw_h = hashlib.sha256()
with open(db_path, "rb") as f:
    while True:
        b = f.read(65536)
        if not b:
            break
        raw_h.update(b)

print(json.dumps({
    "exists": True,
    "integrityOk": integrity_ok,
    "integrityResult": integrity,
    "rawFileSha256": raw_h.hexdigest(),
    "downloadsCount": len(downloads_rows),
    "chunksCount": len(chunks_rows),
    "downloadsHash": canonical_hash(downloads_rows),
    "chunksHash": canonical_hash(chunks_rows),
    "protectedSettingsCount": len(protected_settings),
    "protectedSettingsHash": canonical_hash(protected_settings),
    "volatileSettings": volatile_settings,
    "partFilesCount": len(part_files),
    "partFilesHash": canonical_hash(part_files),
}))
`;

  const out = execFileSync('python', ['-c', pyScript, dbPath, JSON.stringify(allowedVolatileKeys)], {
    encoding: 'utf8',
    timeout: 15000,
  }).trim();
  return JSON.parse(out);
}

function compareOemDatabaseSnapshots(before, after) {
  if (!before || !after || !before.exists || !after.exists) {
    return { ok: false, reason: 'missing_snapshot_or_db' };
  }
  const checks = {
    beforeIntegrityOk: Boolean(before.integrityOk),
    afterIntegrityOk: Boolean(after.integrityOk),
    downloadsCountMatch: before.downloadsCount === after.downloadsCount,
    downloadsHashMatch: before.downloadsHash === after.downloadsHash,
    chunksCountMatch: before.chunksCount === after.chunksCount,
    chunksHashMatch: before.chunksHash === after.chunksHash,
    protectedSettingsHashMatch: before.protectedSettingsHash === after.protectedSettingsHash,
    partFilesCountMatch: before.partFilesCount === after.partFilesCount,
    partFilesHashMatch: before.partFilesHash === after.partFilesHash,
  };
  const volatileDeltas = {};
  const allVolKeys = new Set([
    ...Object.keys(before.volatileSettings || {}),
    ...Object.keys(after.volatileSettings || {}),
  ]);
  for (const k of allVolKeys) {
    const bv = before.volatileSettings?.[k] ?? null;
    const av = after.volatileSettings?.[k] ?? null;
    if (bv !== av) {
      volatileDeltas[k] = { before: bv, after: av };
    }
  }
  return {
    ok: Object.values(checks).every(Boolean),
    rawFileSha256Match: before.rawFileSha256 === after.rawFileSha256,
    checks,
    volatileDeltas,
    counts: {
      downloads: after.downloadsCount,
      chunks: after.chunksCount,
      protectedSettings: after.protectedSettingsCount,
      partFiles: after.partFilesCount,
    },
  };
}

const ROOT = path.resolve(__dirname, '..', '..');
const APPDATA_TORI = path.join(process.env.APPDATA || '', 'tori-download-manager');
const NM_CHR_MANIFEST = path.join(APPDATA_TORI, 'com.tori.download_manager.json');
const NM_FF_MANIFEST = path.join(APPDATA_TORI, 'com.tori.download_manager.firefox.json');

const REG_UNINST = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\TORI Download Manager';
const REG_MANU = 'HKCU\\Software\\tori\\TORI Download Manager';
const REG_NM_CHR = 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager';
const REG_NM_EDGE = 'HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager';
const REG_NM_FF = 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\com.tori.download_manager';

function getShortcutTargets() {
  const candidates = [
    path.join(process.env.USERPROFILE || '', 'Desktop', 'TORI Download Manager.lnk'),
    path.join(process.env.USERPROFILE || '', 'OneDrive', 'Desktop', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager', 'TORI Download Manager.lnk'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'TORI Download Manager.lnk'),
  ];
  try {
    const shellDesk = execFileSync(
      'powershell',
      ['-NoProfile', '-Command', "[Environment]::GetFolderPath('Desktop')"],
      { encoding: 'utf8', timeout: 4000 }
    ).trim();
    if (shellDesk) candidates.push(path.join(shellDesk, 'TORI Download Manager.lnk'));
  } catch {}
  return Array.from(new Set(candidates));
}

function queryRegRaw(keyPath) {
  try {
    return execFileSync('reg', ['query', keyPath], { encoding: 'utf8', timeout: 4000 }).trim();
  } catch {
    return null;
  }
}

function queryRegDefault(keyPath) {
  try {
    const out = execFileSync('reg', ['query', keyPath, '/ve'], { encoding: 'utf8', timeout: 4000 });
    const m = out.match(/REG_SZ\s+(.+)\r?$/m);
    return m ? m[1].trim() : null;
  } catch {
    return null;
  }
}

function getRunningToriProcesses() {
  try {
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        "Get-CimInstance Win32_Process -Filter \"Name='tori-download-manager.exe'\" | Select-Object ProcessId,ExecutablePath | ConvertTo-Json -Compress",
      ],
      { encoding: 'utf8', timeout: 6000 }
    ).trim();
    if (!out) return [];
    const parsed = JSON.parse(out);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return [];
  }
}

function killPidTree(pid) {
  if (!pid) return;
  try {
    execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore', timeout: 5000 });
  } catch {}
}

class QaOemStateGuard {
  constructor(tag = 'qa') {
    this.tag = String(tag).replace(/[^a-zA-Z0-9_-]/g, '_');
    this.backupDir = path.join(ROOT, 'target', '_oem_state_backups', `${this.tag}_${process.pid}_${Date.now()}`);
    this.snapshot = null;
    this.backedUp = false;
    this.restored = false;
    this.oemExePathToRestart = null;
  }

  backup({ stopRunningOem = false } = {}) {
    fs.mkdirSync(this.backupDir, { recursive: true });

    const running = getRunningToriProcesses();
    if (running.length > 0 && running[0].ExecutablePath) {
      this.oemExePathToRestart = running[0].ExecutablePath;
    }

    const regKeys = [
      { name: 'uninstall', key: REG_UNINST, file: path.join(this.backupDir, 'uninstall.reg') },
      { name: 'manu', key: REG_MANU, file: path.join(this.backupDir, 'manu.reg') },
    ];

    const regState = {};
    for (const rk of regKeys) {
      const exists = queryRegRaw(rk.key) !== null;
      if (exists) {
        execFileSync('reg', ['export', rk.key, rk.file, '/y'], { stdio: 'ignore', timeout: 5000 });
        if (!fs.existsSync(rk.file) || fs.statSync(rk.file).size === 0) {
          throw new Error(`QaOemStateGuard failed to export required registry key: ${rk.key}`);
        }
      }
      regState[rk.name] = {
        key: rk.key,
        existed: exists,
        file: rk.file,
        defaultValue: exists ? queryRegDefault(rk.key) : null,
      };
    }

    const nmReg = {
      chrome: queryRegDefault(REG_NM_CHR),
      edge: queryRegDefault(REG_NM_EDGE),
      firefox: queryRegDefault(REG_NM_FF),
    };

    const manifests = {
      chrome: fs.existsSync(NM_CHR_MANIFEST) ? fs.readFileSync(NM_CHR_MANIFEST, 'utf8') : null,
      firefox: fs.existsSync(NM_FF_MANIFEST) ? fs.readFileSync(NM_FF_MANIFEST, 'utf8') : null,
    };

    const shortcuts = [];
    const scPaths = getShortcutTargets();
    for (let i = 0; i < scPaths.length; i++) {
      const p = scPaths[i];
      const bak = path.join(this.backupDir, `lnk_${i}.lnk`);
      const existed = fs.existsSync(p);
      if (existed) {
        fs.copyFileSync(p, bak);
      }
      shortcuts.push({ path: p, existed, bak });
    }

    this.snapshot = { regState, nmReg, manifests, shortcuts };
    fs.writeFileSync(path.join(this.backupDir, 'snapshot.json'), JSON.stringify(this.snapshot, null, 2));
    this.backedUp = true;

    if (stopRunningOem && running.length > 0) {
      for (const proc of running) killPidTree(proc.ProcessId);
    }

    return this.snapshot;
  }

  temporarilySilenceNativeHostAutoSpawn(shieldDir) {
    const dir = shieldDir || this.backupDir;
    fs.mkdirSync(dir, { recursive: true });
    const blockedChr = path.join(dir, 'nm_chr_blocked.json');
    const blockedFf = path.join(dir, 'nm_ff_blocked.json');
    fs.writeFileSync(
      blockedChr,
      JSON.stringify(
        {
          name: 'com.tori.download_manager',
          description: 'TORI QA Isolation Shield',
          path: 'C:\\Windows\\System32\\cmd.exe',
          type: 'stdio',
          allowed_origins: ['chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa/'],
        },
        null,
        2
      )
    );
    fs.writeFileSync(
      blockedFf,
      JSON.stringify(
        {
          name: 'com.tori.download_manager',
          description: 'TORI QA Isolation Shield (Firefox)',
          path: 'C:\\Windows\\System32\\cmd.exe',
          type: 'stdio',
          allowed_extensions: ['qa-isolation-shield@toridm.org'],
        },
        null,
        2
      )
    );
    execFileSync('reg', ['add', REG_NM_CHR, '/ve', '/t', 'REG_SZ', '/d', blockedChr, '/f'], { stdio: 'ignore', timeout: 4000 });
    execFileSync('reg', ['add', REG_NM_EDGE, '/ve', '/t', 'REG_SZ', '/d', blockedChr, '/f'], { stdio: 'ignore', timeout: 4000 });
    execFileSync('reg', ['add', REG_NM_FF, '/ve', '/t', 'REG_SZ', '/d', blockedFf, '/f'], { stdio: 'ignore', timeout: 4000 });
  }

  restore({ qaPathMarker = null, restartOem = true } = {}) {
    if (!this.backedUp || this.restored || !this.snapshot) return { ok: true, skipped: true };
    this.restored = true;
    const { regState, nmReg, manifests, shortcuts } = this.snapshot;

    // 1. Restore Uninstall & Manufacturer InstallDir registry keys
    for (const rk of [regState.uninstall, regState.manu]) {
      try {
        execFileSync('reg', ['delete', rk.key, '/f'], { stdio: 'ignore', timeout: 4000 });
      } catch {}
      if (rk.existed && fs.existsSync(rk.file)) {
        execFileSync('reg', ['import', rk.file], { stdio: 'ignore', timeout: 5000 });
      }
    }

    // 2. Restore Native Messaging manifests & browser registry pointers
    if (manifests.chrome !== null) {
      fs.mkdirSync(path.dirname(NM_CHR_MANIFEST), { recursive: true });
      fs.writeFileSync(NM_CHR_MANIFEST, manifests.chrome, 'utf8');
    }
    if (manifests.firefox !== null) {
      fs.mkdirSync(path.dirname(NM_FF_MANIFEST), { recursive: true });
      fs.writeFileSync(NM_FF_MANIFEST, manifests.firefox, 'utf8');
    }
    for (const [key, val] of [
      [REG_NM_CHR, nmReg.chrome],
      [REG_NM_EDGE, nmReg.edge],
      [REG_NM_FF, nmReg.firefox],
    ]) {
      try {
        if (val) {
          execFileSync('reg', ['add', key, '/ve', '/t', 'REG_SZ', '/d', val, '/f'], { stdio: 'ignore', timeout: 4000 });
        } else {
          execFileSync('reg', ['delete', key, '/f'], { stdio: 'ignore', timeout: 4000 });
        }
      } catch {}
    }

    // 3. Restore shortcuts
    for (const sc of shortcuts) {
      try {
        if (sc.existed && fs.existsSync(sc.bak)) {
          fs.mkdirSync(path.dirname(sc.path), { recursive: true });
          fs.copyFileSync(sc.bak, sc.path);
        } else if (!sc.existed && fs.existsSync(sc.path)) {
          const target = execFileSync(
            'powershell',
            ['-NoProfile', '-Command', `$s=(New-Object -ComObject WScript.Shell).CreateShortcut('${sc.path.replace(/'/g, "''")}'); $s.TargetPath`],
            { encoding: 'utf8', timeout: 4000 }
          ).trim();
          const low = target.toLowerCase();
          if (low.includes('_qa') || (qaPathMarker && low.includes(qaPathMarker.toLowerCase()))) {
            fs.unlinkSync(sc.path);
          }
        }
      } catch {}
    }

    // 4. Verify post-restore parity
    const parity = this.verifyParity();

    // 5. Restart OEM Desktop if it was running before QA
    if (restartOem && this.oemExePathToRestart && fs.existsSync(this.oemExePathToRestart)) {
      try {
        spawn(this.oemExePathToRestart, ['--minimized'], { detached: true, stdio: 'ignore' }).unref();
      } catch {}
      this.oemExePathToRestart = null;
    }

    // Clean up our temporary backup folder after verified restoration
    if (parity.ok) {
      try { fs.rmSync(this.backupDir, { recursive: true, force: true }); } catch {}
    }

    return parity;
  }

  verifyParity() {
    if (!this.snapshot) return { ok: false, reason: 'no_snapshot' };
    const { regState, nmReg, manifests } = this.snapshot;
    const checks = {
      manuExistedMatch: (queryRegRaw(REG_MANU) !== null) === regState.manu.existed,
      manuValMatch: !regState.manu.existed || queryRegDefault(REG_MANU) === regState.manu.defaultValue,
      uninstExistedMatch: (queryRegRaw(REG_UNINST) !== null) === regState.uninstall.existed,
      nmChrRegMatch: queryRegDefault(REG_NM_CHR) === nmReg.chrome,
      nmEdgeRegMatch: queryRegDefault(REG_NM_EDGE) === nmReg.edge,
      nmFfRegMatch: queryRegDefault(REG_NM_FF) === nmReg.firefox,
      nmChrJsonMatch: manifests.chrome === null || (fs.existsSync(NM_CHR_MANIFEST) && fs.readFileSync(NM_CHR_MANIFEST, 'utf8') === manifests.chrome),
      nmFfJsonMatch: manifests.firefox === null || (fs.existsSync(NM_FF_MANIFEST) && fs.readFileSync(NM_FF_MANIFEST, 'utf8') === manifests.firefox),
    };
    const ok = Object.values(checks).every(Boolean);
    return { ok, checks };
  }
}

module.exports = {
  QaOemStateGuard,
  REG_UNINST,
  REG_MANU,
  REG_NM_CHR,
  REG_NM_EDGE,
  REG_NM_FF,
  queryRegDefault,
  queryRegRaw,
  getRunningToriProcesses,
  snapshotOemDatabase,
  compareOemDatabaseSnapshots,
  DEFAULT_ALLOWED_VOLATILE_SETTING_KEYS,
};
