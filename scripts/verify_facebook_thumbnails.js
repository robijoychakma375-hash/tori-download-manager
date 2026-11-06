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
    console.log('TORI GATE 12.5.2: FACEBOOK THUMBNAIL VISUAL & PERSISTENCE VERIFICATION');
    console.log('================================================================\n');

    const exePath = path.resolve('target/release/tori-download-manager.exe');
    if (!fs.existsSync(exePath)) {
        console.error('FAIL: Executable not found at:', exePath);
        process.exit(1);
    }

    const env = {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222'
    };

    console.log('[STEP 1] Launching TORI production executable...');
    let proc = spawn(exePath, [], { detached: false, stdio: 'inherit', env });
    console.log(`Spawned TORI process PID: ${proc.pid}`);
    await sleep(4000);

    let targets = await fetchJson('http://127.0.0.1:9222/json');
    let mainTarget = targets.find(t => t.type === 'page' && !t.url.includes('window=toast'));
    if (!mainTarget) {
        console.error('FAIL: Main window not found in CDP targets');
        proc.kill('SIGTERM');
        process.exit(1);
    }

    let client = await connectCdp(mainTarget.webSocketDebuggerUrl);

    // Wait for table to load
    await sleep(2000);

    // 1. Inspect downloads from IPC
    const downloads = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    console.log(`[VERIFY 1] Total downloads in SQLite: ${downloads.length}`);
    
    const fbDownload = downloads.find(d => 
        (d.filename && d.filename.includes('Annesha Halder')) || 
        (d.url && (d.url.includes('facebook.com') || d.url.includes('fb.watch')))
    );

    if (!fbDownload) {
        console.error('FAIL: Facebook download job not found in SQLite!');
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }

    console.log(`[VERIFY 2] Found Facebook download job:`);
    console.log(`  - ID: ${fbDownload.id}`);
    console.log(`  - Filename: ${fbDownload.filename}`);
    console.log(`  - Status: ${fbDownload.status}`);
    console.log(`  - Has Thumbnail URL: ${Boolean(fbDownload.thumbnail_url)}`);
    if (fbDownload.thumbnail_url) {
        const preview = fbDownload.thumbnail_url.length > 60 
            ? fbDownload.thumbnail_url.substring(0, 50) + '... (total ' + fbDownload.thumbnail_url.length + ' chars)'
            : fbDownload.thumbnail_url;
        console.log(`  - Thumbnail Preview: ${preview}`);
    }

    if (!fbDownload.thumbnail_url || !fbDownload.thumbnail_url.startsWith('data:image/')) {
        console.error('FAIL: Facebook download thumbnail is missing or not a valid data URI!');
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log('  -> PASS: Genuine thumbnail data URI persisted in SQLite');

    // 2. Inspect DOM rendered for the Facebook download row
    const domInspection = await client.evaluate(`
        (() => {
            const rows = Array.from(document.querySelectorAll('.tr'));
            const fbRow = rows.find(r => r.innerText.includes('Annesha Halder'));
            if (!fbRow) return { foundRow: false };
            const img = fbRow.querySelector('img');
            return {
                foundRow: true,
                imgSrc: img ? img.src.substring(0, 60) : null,
                isDataUri: img ? img.src.startsWith('data:image/') : false,
                isFallbackSvg: img ? img.src.includes('.svg') : false,
                complete: img ? img.complete : false,
                naturalWidth: img ? img.naturalWidth : 0,
                naturalHeight: img ? img.naturalHeight : 0,
            };
        })()
    `);

    console.log(`[VERIFY 3] DOM Table Row Thumbnail Inspection:`, JSON.stringify(domInspection, null, 2));
    if (!domInspection.foundRow) {
        console.error('FAIL: Facebook row not found in rendered DOM!');
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    if (!domInspection.isDataUri || domInspection.isFallbackSvg || domInspection.naturalWidth <= 0) {
        console.error('FAIL: Facebook thumbnail image did not render valid image dimensions in DOM!', domInspection);
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log(`  -> PASS: Real thumbnail image rendered in table row (${domInspection.naturalWidth}x${domInspection.naturalHeight}px)`);

    // 3. Capture Main Window Screenshot
    const mainScreenshotPath = path.join(ARTIFACT_DIR, 'gate12_5_2_main_download_facebook_thumbnail.png');
    const localMainScreenshotPath = path.resolve('docs/screenshots/gate12_5_2_main_download_facebook_thumbnail.png');
    await client.captureScreenshot(mainScreenshotPath);
    fs.mkdirSync(path.dirname(localMainScreenshotPath), { recursive: true });
    fs.copyFileSync(mainScreenshotPath, localMainScreenshotPath);
    console.log(`[VERIFY 4] Main window screenshot saved to:\n  ${mainScreenshotPath}`);

    // 4. Open and verify Toast Window
    console.log(`\n[STEP 2] Opening Download Toast for Facebook Reel (${fbDownload.id})...`);
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke('open_progress_window', { id: '${fbDownload.id}' })`);
    await sleep(2500);

    const updatedTargets = await fetchJson('http://127.0.0.1:9222/json');
    const toastTarget = updatedTargets.find(t => t.url && t.url.includes('window=toast'));
    if (!toastTarget) {
        console.error('FAIL: Download Toast target not found');
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }

    const toastClient = await connectCdp(toastTarget.webSocketDebuggerUrl);
    await sleep(2500);

    const toastDebug = await toastClient.evaluate(`
        (async () => {
            const href = window.location.href;
            const search = window.location.search;
            const html = document.body.innerHTML;
            let ipcResult = null;
            let ipcError = null;
            try {
                ipcResult = await window.__TAURI_INTERNALS__.invoke('get_download', { id: '${fbDownload.id}' });
            } catch (e) {
                ipcError = String(e);
            }
            return { href, search, htmlLen: html.length, html, ipcResult, ipcError };
        })()
    `);
    console.log(`[DEBUG TOAST]`, JSON.stringify(toastDebug, null, 2));

    const toastInspection = await toastClient.evaluate(`
        (() => {
            const chip = document.querySelector('.chip');
            const thumbImg = document.querySelector('.toast-thumb-img');
            const fallbackSvg = document.querySelector('.chip-fallback-svg');
            return {
                hasThumbClass: chip ? chip.classList.contains('has-thumb') : false,
                hasImg: !!thumbImg,
                imgSrcPrefix: thumbImg ? thumbImg.src.substring(0, 50) : null,
                imgComplete: thumbImg ? thumbImg.complete : false,
                naturalWidth: thumbImg ? thumbImg.naturalWidth : 0,
                naturalHeight: thumbImg ? thumbImg.naturalHeight : 0,
                svgDisplay: fallbackSvg ? window.getComputedStyle(fallbackSvg).display : null,
            };
        })()
    `);

    console.log(`[VERIFY 5] Download Toast Thumbnail Inspection:`, JSON.stringify(toastInspection, null, 2));
    if (!toastInspection.hasThumbClass || !toastInspection.hasImg || toastInspection.naturalWidth <= 0) {
        console.error('FAIL: Toast did not display thumbnail properly!', toastInspection);
        toastClient.ws.close();
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log(`  -> PASS: Download Toast correctly renders genuine thumbnail (${toastInspection.naturalWidth}x${toastInspection.naturalHeight}px)`);

    // 5. Capture Toast Screenshot
    const toastScreenshotPath = path.join(ARTIFACT_DIR, 'gate12_5_2_toast_facebook_thumbnail.png');
    const localToastScreenshotPath = path.resolve('docs/screenshots/gate12_5_2_toast_facebook_thumbnail.png');
    await toastClient.captureScreenshot(toastScreenshotPath);
    fs.mkdirSync(path.dirname(localToastScreenshotPath), { recursive: true });
    fs.copyFileSync(toastScreenshotPath, localToastScreenshotPath);
    console.log(`[VERIFY 6] Download Toast screenshot saved to:\n  ${toastScreenshotPath}`);

    // Clean up first run
    toastClient.ws.close();
    client.ws.close();
    proc.kill('SIGTERM');
    await sleep(2000);

    // 6. Test Persistence Across Application Restart
    console.log(`\n[STEP 3] Testing Persistence Across Application Restart...`);
    proc = spawn(exePath, [], { detached: false, stdio: 'inherit', env });
    await sleep(4000);

    targets = await fetchJson('http://127.0.0.1:9222/json');
    mainTarget = targets.find(t => t.type === 'page' && !t.url.includes('window=toast'));
    client = await connectCdp(mainTarget.webSocketDebuggerUrl);
    await sleep(2000);

    const restartInspection = await client.evaluate(`
        (() => {
            const rows = Array.from(document.querySelectorAll('.tr'));
            const fbRow = rows.find(r => r.innerText.includes('Annesha Halder'));
            if (!fbRow) return { foundRow: false };
            const img = fbRow.querySelector('img');
            return {
                foundRow: true,
                imgSrc: img ? img.src.substring(0, 60) : null,
                isDataUri: img ? img.src.startsWith('data:image/') : false,
                naturalWidth: img ? img.naturalWidth : 0,
                naturalHeight: img ? img.naturalHeight : 0,
            };
        })()
    `);

    console.log(`[VERIFY 7] Post-Restart Inspection:`, JSON.stringify(restartInspection, null, 2));
    if (!restartInspection.foundRow || !restartInspection.isDataUri || restartInspection.naturalWidth <= 0) {
        console.error('FAIL: Thumbnail did not survive application restart!');
        client.ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log('  -> PASS: Genuine thumbnail persists perfectly across application restart!');

    client.ws.close();
    proc.kill('SIGTERM');
    await sleep(1000);

    console.log('\n================================================================');
    console.log('ALL GATE 12.5.2 FACEBOOK THUMBNAIL VERIFICATION CHECKS PASSED!');
    console.log('================================================================');
}

runVerification().catch((err) => {
    console.error('FATAL VERIFICATION ERROR:', err);
    process.exit(1);
});
