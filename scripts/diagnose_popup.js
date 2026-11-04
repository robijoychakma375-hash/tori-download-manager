const http = require('http');

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function makeRequest(path) {
  return new Promise((resolve, reject) => {
    http.get({ hostname: '127.0.0.1', port: 9224, path }, (res) => {
      let raw = '';
      res.on('data', (c) => raw += c);
      res.on('end', () => {
        try { resolve(JSON.parse(raw)); } catch (_) { resolve(raw); }
      });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(url) {
    this.ws = new WebSocket(url);
    this.id = 1;
    this.pending = new Map();
  }
  async connect() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
      this.ws.onmessage = (e) => {
        const m = JSON.parse(e.data);
        if (m.id && this.pending.has(m.id)) {
          const p = this.pending.get(m.id);
          this.pending.delete(m.id);
          if (m.error) p.reject(m.error); else p.resolve(m.result);
        }
      };
    });
  }
  send(method, params = {}) {
    return new Promise((resolve, reject) => {
      const id = this.id++;
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  close() {
    try { this.ws.close(); } catch (_) {}
  }
}

async function main() {
  await sleep(3000);
  const tabs = await makeRequest('/json/list');
  console.log('Tabs:', tabs.map(t => ({ id: t.id, url: t.url, title: t.title })));

  const ytTab = tabs.find(t => t.url.includes('youtube.com'));
  if (!ytTab) {
    console.error('No YouTube tab found');
    process.exit(1);
  }

  const cdp = new Cdp(ytTab.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send('Runtime.enable');

  console.log('Querying DOM for .tori-mp and .tori-pill...');
  const res = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const mpList = Array.from(document.querySelectorAll('.tori-mp'));
        const pillList = Array.from(document.querySelectorAll('.tori-pill'));
        const pnList = Array.from(document.querySelectorAll('.tori-pn'));

        return {
          mpCount: mpList.length,
          pillCount: pillList.length,
          pnCount: pnList.length,
          mpDetails: mpList.map(mp => {
            const rect = mp.getBoundingClientRect();
            const parent = mp.parentElement;
            const pStyle = parent ? window.getComputedStyle(parent) : null;
            const pn = mp.querySelector('.tori-pn');
            const pnRect = pn ? pn.getBoundingClientRect() : null;
            const pnStyle = pn ? window.getComputedStyle(pn) : null;
            const pill = mp.querySelector('.tori-pill');
            const pillTag = pill ? pill.querySelector('.tori-pill-tag')?.textContent : null;

            return {
              mpClass: mp.className,
              mpRect: { top: rect.top, left: rect.left, width: rect.width, height: rect.height },
              parentTag: parent?.tagName,
              parentClass: parent?.className,
              parentOverflow: pStyle?.overflow,
              parentPosition: pStyle?.position,
              pillTag: pillTag,
              pnClass: pn?.className,
              pnDisplay: pnStyle?.display,
              pnVisibility: pnStyle?.visibility,
              pnRect: pnRect ? { top: pnRect.top, left: pnRect.left, width: pnRect.width, height: pnRect.height } : null,
            };
          }),
        };
      })()
    `,
    returnByValue: true
  });

  console.log('Initial Inspection:', JSON.stringify(res.result?.value, null, 2));

  // Now click the pill!
  console.log('\nClicking .tori-pill...');
  const clickRes = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const pill = document.querySelector('.tori-pill');
        if (!pill) return { error: 'No pill found' };
        pill.click();
        const pn = document.querySelector('.tori-pn');
        const pnStyle = pn ? window.getComputedStyle(pn) : null;
        const pnRect = pn ? pn.getBoundingClientRect() : null;
        return {
          pillClicked: true,
          pnClass: pn?.className,
          pnDisplay: pnStyle?.display,
          pnHtmlLength: pn?.innerHTML?.length,
          pnRect: pnRect ? { top: pnRect.top, left: pnRect.left, width: pnRect.width, height: pnRect.height } : null,
          pnText: pn?.textContent?.substring(0, 100),
        };
      })()
    `,
    returnByValue: true
  });
  console.log('After Click:', JSON.stringify(clickRes.result?.value, null, 2));

  // Wait 1.5s to see if resolution or render occurred
  await sleep(1500);
  const afterWaitRes = await cdp.send('Runtime.evaluate', {
    expression: `
      (() => {
        const pn = document.querySelector('.tori-pn');
        const pnStyle = pn ? window.getComputedStyle(pn) : null;
        const pnRect = pn ? pn.getBoundingClientRect() : null;
        return {
          pnClass: pn?.className,
          pnDisplay: pnStyle?.display,
          pnHtmlLength: pn?.innerHTML?.length,
          pnRect: pnRect ? { top: pnRect.top, left: pnRect.left, width: pnRect.width, height: pnRect.height } : null,
          pnText: pn?.textContent?.substring(0, 200),
          pillTag: document.querySelector('.tori-pill-tag')?.textContent,
        };
      })()
    `,
    returnByValue: true
  });
  console.log('After 1.5s Wait:', JSON.stringify(afterWaitRes.result?.value, null, 2));

  const innerRes = await cdp.send('Runtime.evaluate', {
    expression: `document.querySelector('.tori-pn')?.innerHTML`,
    returnByValue: true
  });
  console.log('PN Full Inner HTML:\n', innerRes.result?.value);

  cdp.close();
  process.exit(0);
}

main().catch(err => {
  console.error('Diag error:', err);
  process.exit(1);
});
