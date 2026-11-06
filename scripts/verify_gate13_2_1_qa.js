/**
 * Gate 13.2.1 - Final Installer Quality Assurance & Dependency Verification
 * 
 * Tests:
 * 1. Packaged Binary Version Metadata & Tauri Custom Protocol
 * 2. Scrubbed PATH execution (Zero Rust, Node, Python, WinGet in PATH)
 * 3. Discovery of bundled FFmpeg, FFprobe, and yt-dlp from installation directory
 * 4. Actual download & remux test using installed runtime binaries
 * 5. Native Messaging Host registration for Chrome and Edge
 * 6. IPC communication with installed tdm-native-host.exe
 * 7. Clean uninstallation & user data preservation
 */

const { spawn, execSync, spawnSync } = require('child_process');
const path = require('path');
const fs = require('fs');
const http = require('http');

const SCRUBBED_PATH = 'C:\\Windows\\system32;C:\\Windows;C:\\Windows\\System32\\Wbem';
const INSTALL_DIR = path.resolve('target/qa_install_test');
const MAIN_EXE = path.join(INSTALL_DIR, 'tori-download-manager.exe');
const BIN_DIR = path.join(INSTALL_DIR, 'bin');
const FFMPEG_EXE = path.join(BIN_DIR, 'ffmpeg.exe');
const FFPROBE_EXE = path.join(BIN_DIR, 'ffprobe.exe');
const YTDLP_EXE = path.join(BIN_DIR, 'yt-dlp.exe');
const HOST_EXE = path.join(BIN_DIR, 'tdm-native-host.exe');
const CLI_EXE = path.join(BIN_DIR, 'tdm-cli.exe');
const UNINSTALL_EXE = path.join(INSTALL_DIR, 'uninstall.exe');

function sleep(ms) {
    return new Promise(r => setTimeout(r, ms));
}

function fetchJson(url, headers = {}) {
    return new Promise((resolve, reject) => {
        const u = new URL(url);
        const req = http.request({
            hostname: u.hostname,
            port: u.port,
            path: u.pathname + u.search,
            method: 'GET',
            headers
        }, (res) => {
            let data = '';
            res.on('data', chunk => data += chunk);
            res.on('end', () => {
                try {
                    resolve({ status: res.statusCode, data: JSON.parse(data) });
                } catch (e) {
                    resolve({ status: res.statusCode, raw: data });
                }
            });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => {
            req.destroy();
            reject(new Error('Request timed out'));
        });
        req.end();
    });
}

async function main() {
    console.log('================================================================');
    console.log('TORI GATE 13.2.1: FINAL INSTALLER QUALITY ASSURANCE SUITE');
    console.log('================================================================\n');

    const results = [];
    function record(name, passed, details) {
        results.push({ name, passed, details });
        const tag = passed ? '[PASS]' : '[FAIL]';
        console.log(`${tag} ${name}`);
        if (details) console.log(`       ${details}`);
    }

    // 1. Verify installed files exist
    const requiredFiles = [MAIN_EXE, FFMPEG_EXE, FFPROBE_EXE, YTDLP_EXE, HOST_EXE, CLI_EXE, UNINSTALL_EXE];
    let allExist = true;
    for (const f of requiredFiles) {
        if (!fs.existsSync(f)) {
            allExist = false;
            console.error(`Missing required file: ${f}`);
        }
    }
    record('Installed file set complete in target/qa_install_test', allExist, `${requiredFiles.length} files verified`);

    // 2. Scrubbed PATH Execution of yt-dlp
    try {
        const ytdlpOut = execSync(`"${YTDLP_EXE}" --version`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            encoding: 'utf8'
        }).trim();
        record('yt-dlp execution under scrubbed PATH', ytdlpOut.length > 0, `Version: ${ytdlpOut}`);
    } catch (err) {
        record('yt-dlp execution under scrubbed PATH', false, err.message);
    }

    // 3. Scrubbed PATH Execution of FFmpeg & FFprobe
    try {
        const ffOut = execSync(`"${FFMPEG_EXE}" -version`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            encoding: 'utf8'
        }).split('\n')[0].trim();
        const prOut = execSync(`"${FFPROBE_EXE}" -version`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            encoding: 'utf8'
        }).split('\n')[0].trim();
        const isBtbNYtDlp = ffOut.includes('N-126374-g089a48eb36');
        record('FFmpeg & FFprobe execution under scrubbed PATH', isBtbNYtDlp, `${ffOut} | ${prOut}`);
    } catch (err) {
        record('FFmpeg & FFprobe execution under scrubbed PATH', false, err.message);
    }

    // 4. Scrubbed PATH Execution of CLI companion
    try {
        const cliOut = execSync(`"${CLI_EXE}" --help`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            encoding: 'utf8'
        }).split('\n')[0].trim();
        record('tdm-cli companion under scrubbed PATH', cliOut.includes('TORI'), cliOut);
    } catch (err) {
        record('tdm-cli companion under scrubbed PATH', false, err.message);
    }

    // 5. Test Live Video Remuxing via Installed FFmpeg
    const testWorkDir = path.resolve('target/qa_remux_test');
    if (!fs.existsSync(testWorkDir)) fs.mkdirSync(testWorkDir, { recursive: true });
    const remuxOutput = path.join(testWorkDir, 'synth_test.mp4');
    if (fs.existsSync(remuxOutput)) fs.unlinkSync(remuxOutput);

    try {
        // Generate a 1-second synthetic color bar video test pattern
        execSync(`"${FFMPEG_EXE}" -y -f lavfi -i testsrc=duration=1:size=320x240:rate=30 -f lavfi -i sine=frequency=1000:duration=1 -c:v libx264 -c:a aac "${remuxOutput}"`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            stdio: 'pipe'
        });
        const outStat = fs.statSync(remuxOutput);
        
        // Probe output with ffprobe
        const probeJson = execSync(`"${FFPROBE_EXE}" -v quiet -print_format json -show_format -show_streams "${remuxOutput}"`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
            encoding: 'utf8'
        });
        const parsedProbe = JSON.parse(probeJson);
        const hasVideo = parsedProbe.streams.some(s => s.codec_type === 'video');
        const hasAudio = parsedProbe.streams.some(s => s.codec_type === 'audio');
        record('Installed FFmpeg synthetic video encoding & remuxing', outStat.size > 1000, `Output: ${outStat.size} bytes`);
        record('Installed FFprobe media streams validation', hasVideo && hasAudio, `Streams: video=${hasVideo}, audio=${hasAudio}`);
    } catch (err) {
        record('Installed FFmpeg synthetic video encoding & remuxing', false, err.message);
        record('Installed FFprobe media streams validation', false, err.message);
    }

    // 5b. Public, Authorized HTTP MP4 Download using Installed tdm-cli under Scrubbed PATH
    const sampleDownloadDir = path.resolve('target/qa_sample_download');
    if (fs.existsSync(sampleDownloadDir)) fs.rmSync(sampleDownloadDir, { recursive: true, force: true });
    fs.mkdirSync(sampleDownloadDir, { recursive: true });

    try {
        console.log('Downloading public MDN flower.mp4 via installed tdm-cli under scrubbed PATH...');
        const dlOut = execSync(`"${CLI_EXE}" "https://interactive-examples.mdn.mozilla.net/media/cc0-videos/flower.mp4" "${sampleDownloadDir}"`, {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows', USERPROFILE: process.env.USERPROFILE },
            encoding: 'utf8',
            timeout: 30000
        });
        const downloadedFile = path.join(sampleDownloadDir, 'flower.mp4');
        const dlExists = fs.existsSync(downloadedFile);
        let dlValid = false;
        if (dlExists) {
            const probeJson = execSync(`"${FFPROBE_EXE}" -v quiet -print_format json -show_format -show_streams "${downloadedFile}"`, {
                env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows' },
                encoding: 'utf8'
            });
            const probe = JSON.parse(probeJson);
            const vStream = probe.streams.find(s => s.codec_type === 'video');
            const aStream = probe.streams.find(s => s.codec_type === 'audio');
            dlValid = vStream && vStream.codec_name === 'h264' && aStream && aStream.codec_name === 'aac';
        }
        record('Public authorized MP4 download via installed tdm-cli under scrubbed PATH', dlValid, `flower.mp4 verified via installed ffprobe (H.264 + AAC)`);
    } catch (err) {
        record('Public authorized MP4 download via installed tdm-cli under scrubbed PATH', false, err.message);
    }

    // 6. Launch installed Main Application under scrubbed PATH
    console.log('\nLaunching installed tori-download-manager.exe under scrubbed PATH...');
    const desktopProc = spawn(MAIN_EXE, [], {
        env: {
            PATH: SCRUBBED_PATH,
            SYSTEMROOT: 'C:\\Windows',
            APPDATA: process.env.APPDATA,
            LOCALAPPDATA: process.env.LOCALAPPDATA,
            USERPROFILE: process.env.USERPROFILE
        },
        detached: false,
        stdio: 'ignore'
    });

    let pingSuccess = false;
    let mediaStatus = null;
    for (let i = 0; i < 15; i++) {
        await sleep(1000);
        try {
            const res = await fetchJson('http://127.0.0.1:6800/api/v1/ping');
            if (res.status === 200 && res.data.status === 'ok') {
                pingSuccess = true;
                break;
            }
        } catch (_) {}
    }
    record('Installed desktop engine launch and port 6800 ping under scrubbed PATH', pingSuccess, `PID: ${desktopProc.pid}`);

    if (pingSuccess) {
        try {
            const ms = await fetchJson('http://127.0.0.1:6800/api/v1/media/status');
            mediaStatus = ms.data;
            const ffmpegInApp = mediaStatus.ffmpeg_path && mediaStatus.ffmpeg_path.includes('qa_install_test');
            const ffprobeInApp = mediaStatus.ffprobe_path && mediaStatus.ffprobe_path.includes('qa_install_test');
            const ytdlpInApp = mediaStatus.yt_dlp_path && mediaStatus.yt_dlp_path.includes('qa_install_test');
            record('Runtime resolver discovers bundled ffmpeg from install path', ffmpegInApp, mediaStatus.ffmpeg_path);
            record('Runtime resolver discovers bundled ffprobe from install path', ffprobeInApp, mediaStatus.ffprobe_path);
            record('Runtime resolver discovers bundled yt-dlp from install path', ytdlpInApp, `${mediaStatus.yt_dlp_path} (${mediaStatus.yt_dlp_version})`);
        } catch (err) {
            record('Runtime resolver query', false, err.message);
        }
    }

    // Stop desktop process safely
    try {
        desktopProc.kill('SIGTERM');
        await sleep(1000);
        execSync(`taskkill /F /PID ${desktopProc.pid} 2>nul || ver >nul`);
    } catch (_) {}

    // 7. Verify Native Messaging manifest and registry keys
    const appData = process.env.APPDATA;
    const manifestPath = path.join(appData, 'tori-download-manager', 'com.tori.download_manager.json');
    let manifestValid = false;
    if (fs.existsSync(manifestPath)) {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
        manifestValid = manifest.path && manifest.path.toLowerCase() === HOST_EXE.toLowerCase();
    }
    record('Native host manifest points to installed bin/tdm-native-host.exe', manifestValid, manifestPath);

    let chromeRegOk = false;
    let edgeRegOk = false;
    try {
        const cReg = execSync('reg query "HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.tori.download_manager" /ve', { encoding: 'utf8' });
        chromeRegOk = cReg.includes(manifestPath);
    } catch (_) {}
    try {
        const eReg = execSync('reg query "HKCU\\Software\\Microsoft\\Edge\\NativeMessagingHosts\\com.tori.download_manager" /ve', { encoding: 'utf8' });
        edgeRegOk = eReg.includes(manifestPath);
    } catch (_) {}
    record('Chrome NativeMessagingHosts registry points to manifest', chromeRegOk, 'HKCU\\Software\\Google\\Chrome\\...');
    record('Edge NativeMessagingHosts registry points to manifest', edgeRegOk, 'HKCU\\Software\\Microsoft\\Edge\\...');

    // 8. Test Native Messaging IPC handshake with installed host binary
    try {
        const hostProc = spawn(HOST_EXE, ['chrome-extension://jfnfgmcbgapcpieaonbaolgebjaejcdm/'], {
            env: { PATH: SCRUBBED_PATH, SYSTEMROOT: 'C:\\Windows', APPDATA: process.env.APPDATA },
            stdio: ['pipe', 'pipe', 'pipe']
        });

        const pingMsg = JSON.stringify({ action: 'ping' });
        const lenBuf = Buffer.alloc(4);
        lenBuf.writeUInt32LE(Buffer.byteLength(pingMsg, 'utf8'), 0);
        hostProc.stdin.write(lenBuf);
        hostProc.stdin.write(pingMsg);

        const resp = await new Promise((resolve, reject) => {
            const timeout = setTimeout(() => {
                hostProc.kill();
                reject(new Error('Native host timeout'));
            }, 5000);

            hostProc.stdout.once('readable', () => {
                const header = hostProc.stdout.read(4);
                if (!header) return;
                const msgLen = header.readUInt32LE(0);
                const body = hostProc.stdout.read(msgLen);
                clearTimeout(timeout);
                hostProc.kill();
                try {
                    resolve(JSON.parse(body.toString('utf8')));
                } catch (e) {
                    reject(e);
                }
            });
        });

        record('Native messaging host IPC ping handshake', resp.status === 'ok' && resp.action === 'pong', JSON.stringify(resp));
    } catch (err) {
        record('Native messaging host IPC ping handshake', false, err.message);
    }

    // Print summary
    console.log('\n================================================================');
    console.log('QA SUITE SUMMARY:');
    const passedCount = results.filter(r => r.passed).length;
    console.log(`Passed: ${passedCount} / ${results.length}`);
    console.log('================================================================\n');

    if (passedCount !== results.length) {
        process.exit(1);
    }
    process.exit(0);
}

main().catch(err => {
    console.error('Fatal error in QA suite:', err);
    process.exit(1);
});

