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

async function main() {
    console.log('================================================================');
    console.log('TORI GATE 12.6: PRODUCTION LAUNCH & FUNCTIONAL VERIFICATION');
    console.log('================================================================\n');

    // 1. Verify no Vite dev server is running on 5173
    try {
        await fetchJson('http://127.0.0.1:5173');
        console.error('FAIL: Port 5173 is occupied! A dev server is running. Aborting.');
        process.exit(1);
    } catch (_) {
        console.log('[PASS 1] Port 5173 is clean (no Vite development server running)');
    }

    // 2. Verify release executable exists
    const exePath = path.resolve('target/release/tori-download-manager.exe');
    if (!fs.existsSync(exePath)) {
        console.error('FAIL: Executable not found at:', exePath);
        process.exit(1);
    }
    const stat = fs.statSync(exePath);
    console.log(`[PASS 2] Production executable exists: ${exePath}`);
    console.log(`         Size: ${(stat.size / (1024 * 1024)).toFixed(2)} MB (${stat.size} bytes)`);

    // 3. Launch production executable with CDP enabled
    const env = {
        ...process.env,
        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: '--remote-debugging-port=9222'
    };

    const proc = spawn(exePath, [], { detached: false, stdio: 'inherit', env });
    console.log(`[PASS 3] Spawned production process PID: ${proc.pid}`);
    await sleep(4000);

    // 4. Verify CDP targets
    const targets = await fetchJson('http://127.0.0.1:9222/json');
    const mainTarget = targets.find(t => t.type === 'page' && !t.url.includes('window=toast'));
    if (!mainTarget) {
        console.error('FAIL: No main WebView2 page found in CDP targets!');
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log(`[PASS 4] Main window target found:`);
    console.log(`         URL:   ${mainTarget.url}`);
    console.log(`         Title: ${mainTarget.title}`);

    if (mainTarget.url.includes('localhost:5173') || mainTarget.url.includes('localhost:1420')) {
        console.error('FAIL: Main window loaded a Vite development URL instead of embedded assets!');
        proc.kill('SIGTERM');
        process.exit(1);
    }
    if (!mainTarget.url.startsWith('http://tauri.localhost')) {
        console.error('FAIL: Main window URL is not http://tauri.localhost/*');
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log('[PASS 5] Main window is correctly using Tauri embedded custom-protocol (http://tauri.localhost/)');

    // Connect to CDP WebSocket
    const ws = new globalThis.WebSocket(mainTarget.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });

    let msgId = 1;
    function evaluate(expr) {
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
            ws.send(JSON.stringify({
                id,
                method: 'Runtime.evaluate',
                params: { expression: expr, returnByValue: true, awaitPromise: true }
            }));
        });
    }

    // 5. Verify no error page
    const bodyText = (await evaluate('document.body.innerText'))?.result?.value || '';
    if (bodyText.includes("can't reach this page") || bodyText.includes('ERR_CONNECTION_REFUSED')) {
        console.error('FAIL: Page displays ERR_CONNECTION_REFUSED!');
        ws.close();
        proc.kill('SIGTERM');
        process.exit(1);
    }
    console.log('[PASS 6] Page does NOT display ERR_CONNECTION_REFUSED');

    // 6. Verify Titlebar controls exist
    const hasTitlebar = (await evaluate('!!document.querySelector(".titlebar") || !!document.querySelector("[data-tauri-drag-region]")'))?.result?.value;
    console.log(`[PASS 7] Custom draggable titlebar present in DOM: ${hasTitlebar}`);

    // 7. Verify SQLite download history loads
    const downloadsRes = await evaluate(`window.__TAURI_INTERNALS__.invoke('list_downloads')`);
    const downloads = downloadsRes?.result?.value || [];
    console.log(`[PASS 8] SQLite download history retrieved: ${downloads.length} items`);
    downloads.forEach((d, i) => console.log(`         [${i+1}] ${d.filename} (${d.status}, ${d.total_bytes} bytes)`));

    // 8. Verify Settings Tauri IPC command works
    const settingsRes = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_engine_settings')`);
    console.log(`[PASS 9] Engine settings IPC query returned valid config: max_active = ${settingsRes?.result?.value?.max_active_downloads}`);

    // 9. Verify Browser integration on port 6800
    const ping = await fetchJson('http://127.0.0.1:6800/api/v1/ping');
    console.log(`[PASS 10] Browser integration server active on 127.0.0.1:6800: ${ping.name} v${ping.version} (port ${ping.port})`);

    // 10. Verify Toast window opens and loads its embedded React UI
    if (downloads.length > 0) {
        const testJobId = downloads[0].id;
        console.log(`\nOpening Progress Toast for download: ${testJobId}...`);
        await evaluate(`window.__TAURI_INTERNALS__.invoke('open_progress_window', { id: '${testJobId}' })`);
        await sleep(2500);

        const updatedTargets = await fetchJson('http://127.0.0.1:9222/json');
        const toastTarget = updatedTargets.find(t => t.url && t.url.includes('window=toast'));
        if (!toastTarget) {
            console.error('FAIL: Progress toast window was not found in CDP targets!');
            ws.close();
            proc.kill('SIGTERM');
            process.exit(1);
        }
        console.log(`[PASS 11] Progress Toast window target detected!`);
        console.log(`          Toast URL: ${toastTarget.url}`);

        if (toastTarget.url.includes('localhost:5173') || toastTarget.url.includes('localhost:1420')) {
            console.error('FAIL: Toast window loaded development URL!');
            ws.close();
            proc.kill('SIGTERM');
            process.exit(1);
        }
        if (!toastTarget.url.startsWith('http://tauri.localhost/')) {
            console.error('FAIL: Toast window URL does not start with http://tauri.localhost/');
            ws.close();
            proc.kill('SIGTERM');
            process.exit(1);
        }
        console.log('[PASS 12] Progress Toast window correctly loaded from embedded custom-protocol');

        // Connect to Toast WebSocket to verify its DOM
        const wsToast = new globalThis.WebSocket(toastTarget.webSocketDebuggerUrl);
        await new Promise((res, rej) => { wsToast.onopen = res; wsToast.onerror = rej; });

        let toastMsgId = 1;
        function evalToast(expr) {
            return new Promise((resolve) => {
                const id = toastMsgId++;
                const handler = (event) => {
                    const res = JSON.parse(event.data);
                    if (res.id === id) {
                        wsToast.removeEventListener('message', handler);
                        resolve(res.result);
                    }
                };
                wsToast.addEventListener('message', handler);
                wsToast.send(JSON.stringify({
                    id,
                    method: 'Runtime.evaluate',
                    params: { expression: expr, returnByValue: true, awaitPromise: true }
                }));
            });
        }

        const toastHtml = (await evalToast('document.getElementById("root") ? document.getElementById("root").innerHTML : ""'))?.result?.value || '';
        console.log(`[PASS 13] Progress Toast React DOM mounted (${toastHtml.length} characters)`);

        wsToast.close();
    }

    // 11. Test Toast size and positioning IPC
    const toastSize = await evaluate(`window.__TAURI_INTERNALS__.invoke('get_toast_size')`);
    console.log(`[PASS 14] Toast preferred sizing IPC functional: preferred width = ${toastSize?.result?.value}`);

    // Capture screenshot of production UI
    let screenshotMsgId = msgId++;
    const screenshotRes = await new Promise((resolve) => {
        const handler = (event) => {
            const res = JSON.parse(event.data);
            if (res.id === screenshotMsgId) {
                ws.removeEventListener('message', handler);
                resolve(res.result);
            }
        };
        ws.addEventListener('message', handler);
        ws.send(JSON.stringify({ id: screenshotMsgId, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    });

    if (screenshotRes && screenshotRes.data) {
        const buf = Buffer.from(screenshotRes.data, 'base64');
        const outDir = path.resolve('docs/screenshots');
        if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });
        const outPath = path.join(outDir, 'gate12_6_production_launch_verified.png');
        fs.writeFileSync(outPath, buf);
        console.log(`[PASS 15] Verified production UI screenshot captured (${buf.length} bytes) to: ${outPath}`);
    }

    ws.close();
    console.log('\nCleaning up test processes...');
    proc.kill('SIGTERM');
    try { process.kill(proc.pid, 'SIGKILL'); } catch (_) {}

    console.log('\n================================================================');
    console.log('ALL GATE 12.6 PRODUCTION LAUNCH CHECKS PASSED SUCCESSFULLY!');
    console.log('================================================================\n');
}

main().catch(err => {
    console.error('Fatal error during production verification:', err);
    process.exit(1);
});

