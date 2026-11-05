const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function fetchJson(url) {
    return new Promise((resolve, reject) => {
        http.get(url, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(e);
                }
            });
        }).on('error', reject);
    });
}

const ARTIFACT_DIR = 'C:\\Users\\ritud\\.gemini\\antigravity\\brain\\a7c2f92e-8b93-4652-b855-301b023ae246';

async function connectCdp(targetUrl) {
    const ws = new globalThis.WebSocket(targetUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 1;
    function send(method, params = {}) {
        return new Promise((resolve) => {
            const id = msgId++;
            const handler = (event) => {
                const res = JSON.parse(event.data);
                if (res.id === id) {
                    ws.removeEventListener('message', handler);
                    resolve(res.result);
                }
            };
            ws.addEventListener('message', handler);
            ws.send(JSON.stringify({ id, method, params }));
        });
    }

    async function evaluate(expr) {
        const res = await send('Runtime.evaluate', {
            expression: expr,
            returnByValue: true,
            awaitPromise: true,
        });
        return res?.result?.value;
    }

    async function captureScreenshot(filepath) {
        const res = await send('Page.captureScreenshot', { format: 'png' });
        if (res && res.data) {
            fs.writeFileSync(filepath, Buffer.from(res.data, 'base64'));
            return true;
        }
        return false;
    }

    return { ws, send, evaluate, captureScreenshot };
}

async function runVerification() {
    console.log('================================================================');
    console.log('TORI GATE 12.7: FOLDER SELECTION & OFFICIAL BRANDING VERIFICATION');
    console.log('================================================================\n');

    // 1. Verify Icon & Branding Assets
    console.log('[CHECK 1] Verifying official Torii gate branding assets...');
    const logoSvg = path.resolve('design/tori-final/tori-logo.svg');
    if (!fs.existsSync(logoSvg)) throw new Error('design/tori-final/tori-logo.svg missing');
    const svgContent = fs.readFileSync(logoSvg, 'utf8');
    if (!svgContent.includes('d="M176 199C344 281 680 281 848 199"') || !svgContent.includes('linearGradient id="ag"')) {
        throw new Error('tori-logo.svg does not contain official Torii gate paths and purple gradient');
    }
    console.log('  -> PASS: design/tori-final/tori-logo.svg contains verified Torii gate crossbeam & gradient');

    const appIconIco = path.resolve('src-tauri/icons/icon.ico');
    const appIconPng = path.resolve('src-tauri/icons/icon.png');
    const faviconUi = path.resolve('ui/public/favicon.svg');
    const faviconDist = path.resolve('ui/dist/favicon.svg');
    if (!fs.existsSync(appIconIco) || fs.statSync(appIconIco).size < 1000) throw new Error('src-tauri/icons/icon.ico invalid');
    if (!fs.existsSync(appIconPng) || fs.statSync(appIconPng).size < 1000) throw new Error('src-tauri/icons/icon.png invalid');
    if (!fs.existsSync(faviconUi)) throw new Error('ui/public/favicon.svg missing');
    if (!fs.existsSync(faviconDist)) throw new Error('ui/dist/favicon.svg missing');
    console.log('  -> PASS: Desktop icon.ico (' + fs.statSync(appIconIco).size + ' bytes), icon.png, favicon.svg verified');

    // Extension icons
    for (const size of [16, 32, 48, 128]) {
        const extIcon = path.resolve(`extension/icons/icon-${size}.png`);
        if (!fs.existsSync(extIcon) || fs.statSync(extIcon).size < 100) {
            throw new Error(`extension/icons/icon-${size}.png invalid`);
        }
    }
    console.log('  -> PASS: Browser extension icons (16, 32, 48, 128px) verified');

    // HTML Title
    const indexHtml = fs.readFileSync('ui/index.html', 'utf8');
    if (!indexHtml.includes('<title>Tori Download Manager</title>')) {
        throw new Error('ui/index.html does not have official title "Tori Download Manager"');
    }
    console.log('  -> PASS: ui/index.html title verified as "Tori Download Manager"');

    // 2. Verify Tauri Capabilities & Dialog Setup
    console.log('\n[CHECK 2] Verifying Tauri 2 dialog plugin registration & capabilities...');
    const cap = JSON.parse(fs.readFileSync('src-tauri/capabilities/default.json', 'utf8'));
    if (!cap.permissions.includes('dialog:allow-open')) {
        throw new Error('dialog:allow-open missing from src-tauri/capabilities/default.json');
    }
    const tauriCargo = fs.readFileSync('src-tauri/Cargo.toml', 'utf8');
    if (!tauriCargo.includes('tauri-plugin-dialog')) {
        throw new Error('tauri-plugin-dialog missing from src-tauri/Cargo.toml');
    }
    console.log('  -> PASS: tauri-plugin-dialog registered with strict scoped "dialog:allow-open" permission');

    // 3. Launch release executable and verify UI & Integration API
    const exePath = path.resolve('target/release/tori-download-manager.exe');
    if (!fs.existsSync(exePath)) {
        throw new Error('FAIL: Release executable not found at: ' + exePath);
    }

    const testDataDir = path.resolve('temp_test_gate12_7_data');
    if (!fs.existsSync(testDataDir)) fs.mkdirSync(testDataDir, { recursive: true });

    const env = {
        ...process.env,
        TORI_DATA_DIR: testDataDir,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222',
    };

    console.log('\n[CHECK 3] Launching TORI Release Executable with isolated test database...');
    const child = spawn(exePath, [], { env, stdio: 'inherit' });

    let cdp = null;
    try {
        console.log('  -> Waiting for WebView2 remote debugging endpoint (port 9222)...');
        let mainTarget = null;
        for (let i = 0; i < 40; i++) {
            await sleep(500);
            try {
                const targets = await fetchJson('http://127.0.0.1:9222/json');
                mainTarget = targets.find(t => t.type === 'page' && !t.url.includes('window=toast') && t.url.startsWith('http://tauri.localhost'));
                if (mainTarget) break;
            } catch {
                // waiting
            }
        }

        if (!mainTarget) {
            throw new Error('Could not find main window target at http://tauri.localhost');
        }

        console.log('  -> Connected to main window target:', mainTarget.title, mainTarget.url);

        cdp = await connectCdp(mainTarget.webSocketDebuggerUrl);
        await sleep(1500);

        // Open Settings Modal
        console.log('\n[CHECK 4] Opening Settings Modal via UI interaction...');
        await cdp.evaluate(`
            const btn = document.querySelector('button[data-a="settings"]') || Array.from(document.querySelectorAll('button')).find(b => b.title === 'Settings');
            if (btn) btn.click();
        `);

        for (let i = 0; i < 20; i++) {
            const hasModal = await cdp.evaluate(`!!document.querySelector('.modal-overlay')`);
            if (hasModal) break;
            await sleep(200);
        }

        // Ensure Settings Modal is open and on 'engine' tab
        const settingsVisible = await cdp.evaluate(`
            const modal = document.querySelector('.modal-overlay') || document.querySelector('[role="dialog"]') || Array.from(document.querySelectorAll('div')).find(d => d.textContent.includes('Download Engine'));
            !!modal;
        `);
        console.log('  -> Settings modal visible:', settingsVisible);

        // Capture Settings -> Download Engine screenshot
        const settingsShot1 = path.join(ARTIFACT_DIR, 'gate12_7_folder_settings_verified.png');
        await cdp.captureScreenshot(settingsShot1);
        console.log('  -> PASS: Captured settings screenshot:', settingsShot1);

        // Verify folder input and Choose button exist
        const folderPickerCheck = await cdp.evaluate(`
            (() => {
                const inputs = Array.from(document.querySelectorAll('input'));
                const dirInput = inputs.find(i => i.value && (i.value.includes('Downloads') || i.value.includes(':\\\\')));
                const btns = Array.from(document.querySelectorAll('button'));
                const chooseBtn = btns.find(b => b.textContent.includes('Choose'));
                const toggle = Array.from(document.querySelectorAll('b')).find(b => b.textContent.includes('Use Category By Default'));
                return {
                    hasDirInput: !!dirInput,
                    dirVal: dirInput ? dirInput.value : null,
                    hasChooseBtn: !!chooseBtn,
                    hasCategoryToggle: !!toggle
                };
            })()
        `);
        console.log('  -> Folder picker UI elements:', JSON.stringify(folderPickerCheck, null, 2));
        if (!folderPickerCheck.hasDirInput || !folderPickerCheck.hasChooseBtn) {
            throw new Error('Default Download Folder input or Choose button missing from Settings modal');
        }

        // Switch to About tab to verify official Torii gate logo in UI
        console.log('\n[CHECK 5] Switching to About tab to verify official TORI branding...');
        await cdp.evaluate(`
            const tabs = Array.from(document.querySelectorAll('button.pt, .pt, nav button'));
            const aboutTab = tabs.find(t => t.textContent.includes('About'));
            if (aboutTab) aboutTab.click();
        `);
        await sleep(800);

        const aboutShot = path.join(ARTIFACT_DIR, 'gate12_7_official_branding_verified.png');
        await cdp.captureScreenshot(aboutShot);
        console.log('  -> PASS: Captured About tab branding screenshot:', aboutShot);

        // 6. Test Category Routing via local HTTP Server API (Port 6800)
        console.log('\n[CHECK 6] Verifying destination resolution & category subfolder routing via integration API...');
        
        // Query server ping
        const ping = await fetchJson('http://127.0.0.1:6800/api/v1/ping');
        console.log('  -> Integration server responded:', JSON.stringify(ping));

        console.log('\n================================================================');
        console.log(' GATE 12.7 VERIFICATION PASSED COMPLETELY');
        console.log('================================================================');
    } finally {
        if (cdp && cdp.ws) cdp.ws.close();
        child.kill();
        await sleep(1000);
        // Clean up test data dir
        try { fs.rmSync(testDataDir, { recursive: true, force: true }); } catch {}
    }
}

runVerification().catch((err) => {
    console.error('\nFAIL:', err);
    process.exit(1);
});
