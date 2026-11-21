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
const { spawn, execFileSync } = require('child_process');

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
};
