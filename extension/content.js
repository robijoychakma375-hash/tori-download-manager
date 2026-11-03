/**
 * TORI Download Manager — Content Script
 * HTML5 Media Detection & Seamless Download Overlay
 */

const PROCESSED_ATTR = 'data-tori-processed';
const MEDIA_EXTENSIONS = ['.mp4', '.webm', '.mkv', '.mov', '.mp3', '.m4a', '.aac', '.flac', '.ogg', '.opus', '.m3u8', '.mpd'];

/**
 * Clean URL and extract basic metadata
 */
function isValidMediaUrl(url) {
  if (!url || typeof url !== 'string') return false;
  const trimmed = url.trim();
  if (trimmed.startsWith('blob:') || trimmed.startsWith('data:')) return false;
  if (!trimmed.startsWith('http://') && !trimmed.startsWith('https://')) return false;
  return true;
}

function extractFilename(url) {
  try {
    const u = new URL(url);
    const last = u.pathname.split('/').filter(Boolean).pop();
    if (last && last.includes('.')) {
      return decodeURIComponent(last).split('?')[0].split('#')[0];
    }
  } catch (_) {}
  return 'media_video.mp4';
}

/**
 * Scan DOM for audio/video elements and report to service worker
 */
function scanMediaElements() {
  const mediaElements = document.querySelectorAll('video, audio');

  mediaElements.forEach((el) => {
    // Check element src
    const candidates = [];
    if (el.currentSrc && isValidMediaUrl(el.currentSrc)) {
      candidates.push(el.currentSrc);
    }
    if (el.src && isValidMediaUrl(el.src) && !candidates.includes(el.src)) {
      candidates.push(el.src);
    }

    // Check source tags
    const sources = el.querySelectorAll('source');
    sources.forEach((s) => {
      if (s.src && isValidMediaUrl(s.src) && !candidates.includes(s.src)) {
        candidates.push(s.src);
      }
    });

    candidates.forEach((url) => {
      chrome.runtime.sendMessage({
        action: 'RECORD_MEDIA_FROM_DOM',
        candidate: {
          url,
          filename: extractFilename(url),
          content_type: el.tagName.toLowerCase() === 'audio' ? 'audio/mpeg' : 'video/mp4',
        },
      });
    });

    // Attach overlay button if not already attached and element is video
    if (el.tagName.toLowerCase() === 'video' && !el.hasAttribute(PROCESSED_ATTR)) {
      attachToriOverlay(el);
      el.setAttribute(PROCESSED_ATTR, 'true');
    }
  });
}

/**
 * Attach non-intrusive 'Download with TORI' badge to HTML5 video element
 */
function attachToriOverlay(videoEl) {
  // Check if video is already wrapped
  const parent = videoEl.parentElement;
  if (!parent) return;

  const btn = document.createElement('button');
  btn.className = 'tori-overlay-btn';
  btn.title = 'Download this media with TORI Download Manager';
  btn.innerHTML = `
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
    <span>TORI</span>
  `;

  btn.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();

    const mediaUrl = videoEl.currentSrc || videoEl.src;
    if (!isValidMediaUrl(mediaUrl)) {
      showToast('Media stream uses internal/blob format. Open TORI popup to check captured stream.', 'warn');
      return;
    }

    btn.classList.add('tori-loading');
    btn.querySelector('span').textContent = 'Starting...';

    chrome.runtime.sendMessage(
      {
        action: 'START_DOWNLOAD',
        url: mediaUrl,
        filename: extractFilename(mediaUrl),
        priority: 'high',
      },
      (res) => {
        btn.classList.remove('tori-loading');
        btn.querySelector('span').textContent = 'TORI';

        if (res && res.status === 'ok') {
          showToast(`Started download: ${res.filename || 'media file'}`, 'success');
        } else if (res && res.status === 'already_exists') {
          showToast(`Download already active in TORI (${res.state || 'downloading'})`, 'info');
        } else {
          showToast(res?.message || 'Failed to trigger TORI download.', 'error');
        }
      }
    );
  });

  // Inject into DOM near video element
  const container = document.createElement('div');
  container.className = 'tori-overlay-container';
  container.appendChild(btn);

  if (window.getComputedStyle(parent).position === 'static') {
    parent.style.position = 'relative';
  }
  parent.appendChild(container);
}

/**
 * Transient in-page toast feedback
 */
function showToast(message, type = 'info') {
  let toast = document.getElementById('tori-page-toast');
  if (!toast) {
    toast = document.createElement('div');
    toast.id = 'tori-page-toast';
    document.body.appendChild(toast);
  }

  toast.textContent = message;
  toast.className = `tori-toast tori-toast-${type} tori-toast-visible`;

  setTimeout(() => {
    toast.classList.remove('tori-toast-visible');
  }, 3500);
}

// Initial scan
scanMediaElements();

// Observe dynamic DOM changes
const observer = new MutationObserver(() => {
  scanMediaElements();
});

observer.observe(document.body || document.documentElement, {
  childList: true,
  subtree: true,
});

