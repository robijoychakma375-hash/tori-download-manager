const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// Let's use Python via execFileSync or native node crypto
const UPLOADED_XPI = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\4cb6b42b-ac51-4843-b5b6-6960f8030e35\\.user_uploaded\\media_1795086593808_55df31da.xpi';
const EXPECTED_SHA = 'a93a43872d224426902c49e217e31b2c603263d8c260c429940539b34b2852b8';
const UNSIGNED_ZIP = path.resolve(__dirname, '..', 'release', 'v1.0.10-extension-rc', 'tori-companion-v1.0.10-firefox.zip');

function sha256File(filePath) {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

console.log('=== GATE 31.2 SIGNED XPI AUDIT ===');
console.log('Target XPI:', UPLOADED_XPI);

if (!fs.existsSync(UPLOADED_XPI)) {
  console.error('[FAIL] Uploaded XPI does not exist at path');
  process.exit(1);
}

const actualSha = sha256File(UPLOADED_XPI);
console.log('Actual SHA-256:  ', actualSha);
console.log('Expected SHA-256:', EXPECTED_SHA);
const shaMatch = actualSha === EXPECTED_SHA;
console.log('SHA Match:       ', shaMatch ? '[PASS]' : '[FAIL]');

if (!shaMatch) {
  console.error('[FAIL] SHA-256 mismatch!');
  process.exit(1);
}

// Compare contents with unsigned zip using Python script
const pyScript = path.join(__dirname, 'compare_xpi_detail.py');
fs.writeFileSync(pyScript, `
import sys, os, hashlib, zipfile, json

xpi_path = sys.argv[1]
zip_path = sys.argv[2]

with zipfile.ZipFile(xpi_path, 'r') as zx, zipfile.ZipFile(zip_path, 'r') as zu:
    x_bad = zx.testzip()
    u_bad = zu.testzip()
    print("XPI testzip:", "OK" if x_bad is None else x_bad)
    print("ZIP testzip:", "OK" if u_bad is None else u_bad)

    x_files = {i.filename: zx.read(i.filename) for i in zx.infolist() if not i.is_dir()}
    u_files = {i.filename: zu.read(i.filename) for i in zu.infolist() if not i.is_dir()}

    meta_files = sorted([f for f in x_files if f.startswith('META-INF/')])
    print(f"Signature metadata entries ({len(meta_files)}):", meta_files)

    app_x = {k: v for k, v in x_files.items() if not k.startswith('META-INF/')}
    app_u = {k: v for k, v in u_files.items() if not k.startswith('META-INF/')}

    print(f"App files in XPI: {len(app_x)}")
    print(f"App files in ZIP: {len(app_u)}")

    missing_in_xpi = sorted(set(app_u) - set(app_x))
    extra_in_xpi = sorted(set(app_x) - set(app_u))
    print("Missing in XPI:", missing_in_xpi)
    print("Extra in XPI:", extra_in_xpi)

    diff_content = []
    identical_count = 0
    for k in sorted(set(app_x) & set(app_u)):
        if app_x[k] == app_u[k]:
            identical_count += 1
        else:
            diff_content.append(k)

    print(f"Identical files: {identical_count}")
    print(f"Content diffs: {diff_content}")

    mf_x = json.loads(app_x['manifest.json'].decode('utf-8'))
    mf_u = json.loads(app_u['manifest.json'].decode('utf-8'))
    print("XPI Manifest details:")
    print("  Version:", mf_x.get('version'))
    print("  Gecko ID:", mf_x.get('browser_specific_settings', {}).get('gecko', {}).get('id'))
    print("  Strict min version:", mf_x.get('browser_specific_settings', {}).get('gecko', {}).get('strict_min_version'))
    print("  Permissions:", mf_x.get('permissions'))
    print("Manifests parsed equal:", mf_x == mf_u)
    if mf_x != mf_u:
        print("Manifest differences:")
        for k in sorted(set(mf_x.keys()) | set(mf_u.keys())):
            if k not in mf_x:
                print(f"  Only in ZIP: {k} = {mf_u[k]}")
            elif k not in mf_u:
                print(f"  Only in XPI: {k} = {mf_x[k]}")
            elif mf_x[k] != mf_u[k]:
                print(f"  Difference in {k}:")
                print(f"    XPI: {mf_x[k]}")
                print(f"    ZIP: {mf_u[k]}")
    else:
        print("Manifest parsed content is 100% IDENTICAL! (diff was only whitespace/newline formatting by AMO)")
`);

const { execFileSync } = require('child_process');
try {
  const out = execFileSync('python', [pyScript, UPLOADED_XPI, UNSIGNED_ZIP], { encoding: 'utf8' });
  console.log(out);
} finally {
  try { fs.unlinkSync(pyScript); } catch {}
}
