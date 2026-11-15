import { useEffect, useState, useMemo, useCallback, useRef } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import type {
  AppSettings,
  CategoryCounts,
  CategoryKey,
  DownloadEvent,
  DownloadJob,
  DownloadProgress,
  PendingPlaylistRequest,
  SortDirection,
  SortField,
} from './types';
import { TitleBar } from './components/TitleBar';
import { MenuBar } from './components/MenuBar';
import { ToolBar } from './components/ToolBar';
import { SideBar } from './components/SideBar';
import { DownloadTable } from './components/DownloadTable';
import { StatusBar } from './components/StatusBar';
import { AddDownloadModal } from './components/AddDownloadModal';
import { ProgressModal } from './components/ProgressModal';
import { DownloadToast } from './components/DownloadToast';
import { SettingsModal } from './components/SettingsModal';
import { ContextMenu } from './components/ContextMenu';
import { DeleteConfirmModal } from './components/DeleteConfirmModal';
import { PlaylistModal } from './components/PlaylistModal';
import { typeOfJob, isMediaPageUrl } from './utils';
import { checkForUpdate } from './updater';
import type { Update } from '@tauri-apps/plugin-updater';

const DEFAULT_SETTINGS: AppSettings = {
  dir: 'C:\\Users\\User\\Downloads',
  sort: true,
  con: 16,
  maxa: 4,
  limMode: 'off',
  limV: 256,
  limU: 'KiB/s',
  retries: 3,
  dyn: true,
  mps: 512,
  mpsU: 'KiB',
  ua: '',
  ssl: false,
  lm: false,
  track: true,
  dns: 'System DNS',
  proxy: 'none',
  port: 7070,
  key: 'tori_live_api_key_v2',
  cap: true,
  theme: 'system',
  accent: 'indigo',
  motion: false,
  details: false,
  showDownloadPopup: 'always',
  alwaysOnTop: true,
  closeToTray: true,
};

function loadStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('tori_settings_v2');
    if (raw) {
      const parsed = JSON.parse(raw);
      return {
        ...DEFAULT_SETTINGS,
        ...parsed,
        alwaysOnTop: parsed.alwaysOnTop !== undefined ? parsed.alwaysOnTop : true,
        closeToTray: parsed.closeToTray !== undefined ? parsed.closeToTray : true,
      };
    }
  } catch (err) {
    console.error('Failed to parse stored settings:', err);
  }
  return DEFAULT_SETTINGS;
}

const DEMO_DOWNLOADS: DownloadJob[] = [
  {
    id: 'demo-1',
    filename: 'Firefox 61.0.2.dmg',
    url: 'https://download-installer.cdn.mozilla.net/pub/firefox/releases/61.0.2/mac/en-US/Firefox%2061.0.2.dmg',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\Firefox 61.0.2.dmg',
    temp_path: 'C:\\Users\\User\\Downloads\\Firefox 61.0.2.dmg.tdm-part',
    total_bytes: 55283000,
    downloaded_bytes: 48860000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 11,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:42',
    updated_at: 'Today 10:42',
    speed_bps: 1850000,
    eta_seconds: 3,
  },
  {
    id: 'demo-2',
    filename: 'ubuntu-24.04-desktop-amd64.iso',
    url: 'https://releases.ubuntu.com/24.04/ubuntu-24.04-desktop-amd64.iso',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\ubuntu-24.04-desktop-amd64.iso',
    temp_path: 'C:\\Users\\User\\Downloads\\ubuntu-24.04-desktop-amd64.iso.tdm-part',
    total_bytes: 5900000000,
    downloaded_bytes: 1829000000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:40',
    updated_at: 'Today 10:40',
    speed_bps: 4200000,
    eta_seconds: 969,
  },
  {
    id: 'demo-3',
    filename: 'Big Buck Bunny 1080p.mp4',
    url: 'https://cdn.example.com/files/Big Buck Bunny 1080p.mp4',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\Big Buck Bunny 1080p.mp4',
    temp_path: 'C:\\Users\\User\\Downloads\\Big Buck Bunny 1080p.mp4.tdm-part',
    total_bytes: 420000000,
    downloaded_bytes: 268800000,
    state: 'downloading',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 11,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:31',
    updated_at: 'Today 10:31',
    speed_bps: 890000,
    eta_seconds: 170,
  },
  {
    id: 'demo-4',
    filename: 'setup-vscode-x64.exe',
    url: 'https://cdn.example.com/files/setup-vscode-x64.exe',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\setup-vscode-x64.exe',
    temp_path: 'C:\\Users\\User\\Downloads\\setup-vscode-x64.exe.tdm-part',
    total_bytes: 96000000,
    downloaded_bytes: 0,
    state: 'queued',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Today 10:20',
    updated_at: 'Today 10:20',
  },
  {
    id: 'demo-5',
    filename: 'photos-2026.zip',
    url: 'https://cdn.example.com/files/photos-2026.zip',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\photos-2026.zip',
    temp_path: 'C:\\Users\\User\\Downloads\\photos-2026.zip.tdm-part',
    total_bytes: 820000000,
    downloaded_bytes: 336200000,
    state: 'paused',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Yesterday',
    updated_at: 'Yesterday',
  },
  {
    id: 'demo-6',
    filename: 'project-assets.zip',
    url: 'https://cdn.example.com/files/project-assets.zip',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\project-assets.zip',
    temp_path: 'C:\\Users\\User\\Downloads\\project-assets.zip.tdm-part',
    total_bytes: 820000000,
    downloaded_bytes: 820000000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 16,
    priority: 'normal',
    error_message: null,
    created_at: 'Yesterday',
    updated_at: 'Yesterday',
  },
  {
    id: 'demo-7',
    filename: 'lecture-recording.mp3',
    url: 'https://cdn.example.com/files/lecture-recording.mp3',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\lecture-recording.mp3',
    temp_path: 'C:\\Users\\User\\Downloads\\lecture-recording.mp3.tdm-part',
    total_bytes: 48000000,
    downloaded_bytes: 48000000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 8,
    priority: 'normal',
    error_message: null,
    created_at: 'Mon 09:12',
    updated_at: 'Mon 09:12',
  },
  {
    id: 'demo-8',
    filename: 'annual-report.pdf',
    url: 'https://cdn.example.com/files/annual-report.pdf',
    resolved_url: null,
    target_path: 'C:\\Users\\User\\Downloads\\annual-report.pdf',
    temp_path: 'C:\\Users\\User\\Downloads\\annual-report.pdf.tdm-part',
    total_bytes: 12400000,
    downloaded_bytes: 12400000,
    state: 'completed',
    job_type: 'http_file',
    etag: null,
    last_modified: null,
    is_resumable: true,
    chunk_count: 4,
    priority: 'normal',
    error_message: null,
    created_at: 'Mon 08:50',
    updated_at: 'Mon 08:50',
  },
];

function computeJobPercent(job: DownloadJob): number {
  if (job.state === 'completed') return 100;
  const total = job.total_bytes || 0;
  if (total <= 0) return 0;
  return Math.min(100, Math.max(0, (job.downloaded_bytes / total) * 100));
}

function parseJobDate(job: DownloadJob): number {
  const ts = Date.parse(job.updated_at || job.created_at || '');
  return Number.isNaN(ts) ? 0 : ts;
}

export function App() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const windowMode = urlParams.get('window');
  const windowJobId = urlParams.get('id');

  if (windowMode === 'toast' || windowMode === 'progress') {
    document.documentElement.classList.add('toast-mode');
    return <DownloadToast initialId={windowJobId || undefined} />;
  }

  return <MainWindow urlParams={urlParams} />;
}

function MainWindow({ urlParams }: { urlParams: URLSearchParams }) {
  const isDemoMode = urlParams.get('demo') === '1';
  const [downloads, setDownloads] = useState<DownloadJob[]>(() =>
    isDemoMode ? DEMO_DOWNLOADS : []
  );
  const knownIdsRef = useRef<Set<string>>(new Set());
  const pendingProgressRef = useRef<Map<string, DownloadProgress>>(new Map());
  const flushTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastFlushTimeRef = useRef<number>(0);
  const lastUnknownReloadRef = useRef<number>(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);

  const [selectedIds, setSelectedIds] = useState<Set<string>>(() => {
    if (!isDemoMode) return new Set();
    return urlParams.get('sel') === 'multi'
      ? new Set(DEMO_DOWNLOADS.slice(0, 3).map((d) => d.id))
      : new Set(DEMO_DOWNLOADS.length > 0 ? [DEMO_DOWNLOADS[0].id] : []);
  });
  const [lastFocusedId, setLastFocusedId] = useState<string | null>(null);
  const [currentCategory, setCurrentCategory] = useState<CategoryKey>('all');
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<SortField | null>(null);
  const [sortDir, setSortDir] = useState<SortDirection>('desc');

  const [settings, setSettings] = useState<AppSettings>(() => {
    const s = loadStoredSettings();
    const urlAccent = urlParams.get('accent');
    if (urlAccent && ['indigo', 'ocean', 'emerald', 'rose'].includes(urlAccent)) {
      s.accent = urlAccent as AppSettings['accent'];
    }
    const urlTheme = urlParams.get('theme');
    if (urlTheme && ['light', 'dark', 'system'].includes(urlTheme)) {
      s.theme = urlTheme as AppSettings['theme'];
    }
    return s;
  });
  const settingsRef = useRef(settings);
  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  const [isExtensionConnected, setIsExtensionConnected] = useState(false);

  // Modals & popups
  const [isAddModalOpen, setIsAddModalOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('modal') === 'add';
    } catch {
      return false;
    }
  });
  const playlistNonceRef = useRef(1);
  const handledPlaylistRequestIdsRef = useRef<Set<string>>(new Set());
  const [playlistModalState, setPlaylistModalState] = useState<{
    url: string;
    requestId?: string;
    supersededRequestIds?: string[];
    nonce: number;
  } | null>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('modal') === 'playlist') {
        return {
          url: 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335',
          nonce: 1,
        };
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [progressJobId, setProgressJobId] = useState<string | null>(null);
  const [settingsInitialTab, setSettingsInitialTab] = useState<
    'appearance' | 'engine' | 'integration' | 'about'
  >('engine');
  const [availableUpdate, setAvailableUpdate] = useState<Update | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('modal') === 'settings';
    } catch {
      return false;
    }
  });

  useEffect(() => {
    if (settings.autoCheckUpdates !== false) {
      const now = Date.now();
      const lastCheck = settings.lastUpdateCheck || 0;
      const remindUntil = settings.remindLaterUntil || 0;
      const oneDayMs = 24 * 60 * 60 * 1000;

      if (now - lastCheck > oneDayMs && now >= remindUntil) {
        checkForUpdate()
          .then((res) => {
            if (res.available && res.update) {
              setAvailableUpdate(res.update);
            }
          })
          .catch(() => { });
      }
    }
  }, [settings.autoCheckUpdates, settings.lastUpdateCheck, settings.remindLaterUntil]);

  const [deleteConfirmJobs, setDeleteConfirmJobs] = useState<DownloadJob[] | null>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('modal') === 'delete') {
        return DEMO_DOWNLOADS.slice(0, 3);
      }
    } catch {
      // ignore
    }
    return null;
  });
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    job: DownloadJob;
  } | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    setTimeout(() => {
      setToastMessage((prev) => (prev === msg ? null : prev));
    }, 2400);
  }, []);

  // Sync theme, accent & motion preference with document element
  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
      document.documentElement.dataset.accent = settings.accent || 'indigo';
      document.documentElement.dataset.reduceMotion = settings.motion ? 'true' : 'false';
      document.documentElement.style.backgroundColor = isDark ? '#232326' : '#f5f5f8';
    };

    applyTheme();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      if (settings.theme === 'system') applyTheme();
    };
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [settings.theme, settings.accent, settings.motion]);

  const settingsWriteQueueRef = useRef<Promise<void>>(Promise.resolve());
  const handleUpdateSettings = useCallback((newSettings: AppSettings) => {
    settingsRef.current = newSettings;
    setSettings(newSettings);
    try {
      localStorage.setItem('tori_settings_v2', JSON.stringify(newSettings));
    } catch (err) {
      console.error('Failed to store settings:', err);
    }
    settingsWriteQueueRef.current = settingsWriteQueueRef.current
      .then(() => invoke<void>('update_engine_settings', { settings: newSettings }))
      .catch((err) => {
        console.error('Failed to push settings to Rust engine:', err);
      });
  }, []);

  // Synchronize settings with Rust backend on startup (SQLite app_settings is authoritative)
  useEffect(() => {
    const syncSettings = async () => {
      try {
        const migratedKey = 'tori_settings_v104_tray_migrated';
        const hasMigrated = localStorage.getItem(migratedKey) === 'true';

        const backendSettings = await invoke<AppSettings | null>('get_engine_settings');
        if (backendSettings) {
          setSettings((prev) => {
            let closeToTrayVal =
              typeof backendSettings.closeToTray === 'boolean'
                ? backendSettings.closeToTray
                : true;

            if (!hasMigrated) {
              closeToTrayVal = true;
              localStorage.setItem(migratedKey, 'true');
            }

            const merged: AppSettings = {
              ...prev,
              ...backendSettings,
              alwaysOnTop:
                typeof backendSettings.alwaysOnTop === 'boolean'
                  ? backendSettings.alwaysOnTop
                  : prev.alwaysOnTop !== undefined
                  ? prev.alwaysOnTop
                  : true,
              closeToTray: closeToTrayVal,
            };
            // Allow URL params to override theme/accent cleanly when capturing screenshots
            const urlAccent = urlParams.get('accent');
            if (urlAccent && ['indigo', 'ocean', 'emerald', 'rose'].includes(urlAccent)) {
              merged.accent = urlAccent as AppSettings['accent'];
            }
            const urlTheme = urlParams.get('theme');
            if (urlTheme && ['light', 'dark', 'system'].includes(urlTheme)) {
              merged.theme = urlTheme as AppSettings['theme'];
            }
            try {
              localStorage.setItem('tori_settings_v2', JSON.stringify(merged));
            } catch {
              // ignore
            }
            if (!hasMigrated && backendSettings.closeToTray !== true) {
              invoke('update_engine_settings', { settings: merged }).catch(() => { });
            }
            return merged;
          });
        } else {
          const initial: AppSettings = { ...settingsRef.current, closeToTray: true };
          localStorage.setItem(migratedKey, 'true');
          setSettings(initial);
          try {
            localStorage.setItem('tori_settings_v2', JSON.stringify(initial));
          } catch {
            // ignore
          }
          await invoke('update_engine_settings', { settings: initial });
        }
      } catch (err) {
        console.error('Failed to sync engine settings:', err);
      }
    };
    syncSettings();
  }, [urlParams]);

  // Keep knownIdsRef aligned for fast lookup during high-frequency progress events
  useEffect(() => {
    knownIdsRef.current = new Set(downloads.map((d) => d.id));
  }, [downloads]);

  // Load downloads from SQLite backend (strictly real data; demo items only if explicitly ?demo=1)
  const loadDownloads = useCallback(async () => {
    if (isDemoMode) {
      setDownloads(DEMO_DOWNLOADS);
      return;
    }
    try {
      const list = await invoke<DownloadJob[]>('list_downloads');
      const resolved = list || [];
      knownIdsRef.current = new Set(resolved.map((d) => d.id));
      setDownloads(resolved);
      setSelectedIds((prev) =>
        prev.size > 0 ? prev : new Set(resolved.length > 0 ? [resolved[0].id] : [])
      );
    } catch (err) {
      console.error('Failed to load downloads from SQLite:', err);
      setDownloads([]);
    }
  }, [isDemoMode]);

  const flushPendingProgress = useCallback(() => {
    if (flushTimerRef.current !== null) {
      clearTimeout(flushTimerRef.current);
      flushTimerRef.current = null;
    }
    if (pendingProgressRef.current.size === 0) return;

    const batch = new Map(pendingProgressRef.current);
    pendingProgressRef.current.clear();
    lastFlushTimeRef.current = Date.now();

    setDownloads((prev) => {
      let anyChanged = false;
      const next = prev.map((job) => {
        const p = batch.get(job.id);
        if (!p) return job;

        const nextTotal = p.total_bytes ?? job.total_bytes;
        const nextErr = p.error_message ?? job.error_message;
        if (
          job.downloaded_bytes === p.downloaded_bytes &&
          job.total_bytes === nextTotal &&
          job.speed_bps === p.speed_bps &&
          job.eta_seconds === p.eta_seconds &&
          job.state === p.state &&
          job.error_message === nextErr
        ) {
          return job;
        }
        anyChanged = true;
        return {
          ...job,
          downloaded_bytes: p.downloaded_bytes,
          total_bytes: nextTotal,
          speed_bps: p.speed_bps,
          eta_seconds: p.eta_seconds,
          state: p.state,
          error_message: nextErr,
        };
      });
      return anyChanged ? next : prev;
    });
  }, []);

  const scheduleProgressFlush = useCallback(() => {
    const intervalMs = document.hidden ? 1500 : 1000;
    const elapsed = Date.now() - lastFlushTimeRef.current;
    if (elapsed >= intervalMs) {
      flushPendingProgress();
      return;
    }
    if (flushTimerRef.current === null) {
      flushTimerRef.current = setTimeout(() => {
        flushTimerRef.current = null;
        flushPendingProgress();
      }, Math.max(16, intervalMs - elapsed));
    }
  }, [flushPendingProgress]);

  const openPlaylistDialog = useCallback(
    (url: string, requestId?: string, supersededRequestIds?: string[]) => {
      const cleanUrl = (url || '').trim();
      if (!cleanUrl) return;
      if (requestId) {
        if (handledPlaylistRequestIdsRef.current.has(requestId)) {
          return;
        }
        handledPlaylistRequestIdsRef.current.add(requestId);
        if (handledPlaylistRequestIdsRef.current.size > 100) {
          const oldest = handledPlaylistRequestIdsRef.current.values().next().value;
          if (oldest) handledPlaylistRequestIdsRef.current.delete(oldest);
        }
      }
      if (supersededRequestIds && supersededRequestIds.length > 0) {
        for (const id of supersededRequestIds) {
          handledPlaylistRequestIdsRef.current.add(id);
        }
      }
      setIsAddModalOpen(false);
      setIsSettingsModalOpen(false);
      setDeleteConfirmJobs(null);
      setContextMenu(null);
      setProgressJobId(null);
      setPlaylistModalState({
        url: cleanUrl,
        requestId,
        supersededRequestIds,
        nonce: ++playlistNonceRef.current,
      });
    },
    []
  );

  const syncPendingPlaylistRequests = useCallback(async () => {
    try {
      const pending = await invoke<PendingPlaylistRequest[]>('take_pending_playlist_requests');
      if (!Array.isArray(pending) || pending.length === 0) return;
      const fresh = pending.filter(
        (req) => req?.request_id && !handledPlaylistRequestIdsRef.current.has(req.request_id)
      );
      if (fresh.length === 0) return;
      const latest = fresh[fresh.length - 1];
      const superseded = fresh.slice(0, -1).map((r) => r.request_id);
      openPlaylistDialog(latest.url, latest.request_id, superseded);
    } catch (err) {
      console.error('Failed to synchronize pending playlist requests:', err);
    }
  }, [openPlaylistDialog]);

  useEffect(() => {
    let disposed = false;
    if (!isDemoMode) {
      void (async () => {
        if (!disposed) {
          await loadDownloads();
        }
      })();
    }

    invoke<string>('get_default_download_dir')
      .then((dir) => {
        if (dir) {
          setSettings((prev) => (prev.dir && prev.dir.trim() !== '' ? prev : { ...prev, dir }));
        }
      })
      .catch((err) => console.error('Failed to get default dir:', err));

    const checkExt = () => {
      invoke<boolean>('check_extension_status')
        .then((status) => setIsExtensionConnected(!!status))
        .catch(() => setIsExtensionConnected(false));
    };
    checkExt();
    const extInterval = setInterval(checkExt, 8000);

    const handleVisibilityChange = () => {
      if (!document.hidden) {
        flushPendingProgress();
        loadDownloads();
        syncPendingPlaylistRequests();
      }
    };
    document.addEventListener('visibilitychange', handleVisibilityChange);

    const unlistenPromise = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;

      if (payload.type === 'Progress') {
        const p = payload.payload;
        if (!knownIdsRef.current.has(p.id)) {
          const now = Date.now();
          if (now - lastUnknownReloadRef.current > 500) {
            lastUnknownReloadRef.current = now;
            loadDownloads();
          }
        }
        pendingProgressRef.current.set(p.id, p);
        scheduleProgressFlush();
      } else if (payload.type === 'StateChanged') {
        const sc = payload.payload;
        const buffered = pendingProgressRef.current.get(sc.id);
        pendingProgressRef.current.delete(sc.id);

        if (!knownIdsRef.current.has(sc.id)) {
          loadDownloads();
        } else {
          setDownloads((prev) =>
            prev.map((job) => {
              if (job.id !== sc.id) return job;
              const isDone = sc.state === 'completed';
              const isPaused = sc.state === 'paused' || sc.state === 'cancelled';
              const baseTotal = buffered?.total_bytes ?? job.total_bytes;
              const baseDownloaded = buffered?.downloaded_bytes ?? job.downloaded_bytes;
              return {
                ...job,
                state: sc.state,
                error_message: sc.error,
                total_bytes: baseTotal,
                speed_bps: isDone || isPaused ? 0 : (buffered?.speed_bps ?? job.speed_bps),
                eta_seconds: isDone || isPaused ? null : (buffered?.eta_seconds ?? job.eta_seconds),
                downloaded_bytes:
                  isDone && baseTotal && baseTotal > 0 ? baseTotal : baseDownloaded,
              };
            })
          );
          if (sc.state === 'completed' || sc.state === 'failed' || sc.state === 'downloading') {
            loadDownloads();
          }
        }
      } else if (payload.type === 'Deleted') {
        const { id } = payload.payload;
        pendingProgressRef.current.delete(id);
        setDownloads((prev) => prev.filter((j) => j.id !== id));
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      } else if (payload.type === 'OpenPlaylistModal') {
        syncPendingPlaylistRequests();
      }
    });

    const unlistenDeletedPromise = listen<string>('download-deleted', (event) => {
      const id = event.payload;
      if (id) {
        pendingProgressRef.current.delete(id);
        setDownloads((prev) => prev.filter((j) => j.id !== id));
        setSelectedIds((prev) => {
          if (!prev.has(id)) return prev;
          const next = new Set(prev);
          next.delete(id);
          return next;
        });
      }
    });

    const unlistenPlaylistRequestPromise = listen<PendingPlaylistRequest>(
      'open-playlist-modal-request',
      (event) => {
        const req = event.payload;
        if (req?.url) {
          openPlaylistDialog(req.url, req.request_id);
        }
      }
    );

    const unlistenPlaylistModalPromise = listen<string>('open-playlist-modal', (event) => {
      const url = event.payload;
      if (url) {
        openPlaylistDialog(url);
      }
    });

    const unlistenNotifyPromise = listen<{ id: string; filename: string }>(
      'download-complete-notification',
      (event) => {
        if (event.payload?.filename) {
          showToast(`Download complete: ${event.payload.filename}`);
        }
      }
    );

    const allListeners = Promise.all([
      unlistenPromise,
      unlistenDeletedPromise,
      unlistenPlaylistRequestPromise,
      unlistenPlaylistModalPromise,
      unlistenNotifyPromise,
    ]);

    allListeners
      .then(async () => {
        if (disposed) return;
        await invoke('frontend_ready').catch(() => {
          invoke('show_main_window').catch(() => { });
        });
        if (!disposed) {
          await syncPendingPlaylistRequests();
        }
      })
      .catch((err) => {
        console.error('Failed to register Tauri listeners:', err);
      });

    return () => {
      disposed = true;
      clearInterval(extInterval);
      if (flushTimerRef.current !== null) {
        clearTimeout(flushTimerRef.current);
        flushTimerRef.current = null;
      }
      document.removeEventListener('visibilitychange', handleVisibilityChange);
      allListeners.then((unlisteners) => {
        for (const unlisten of unlisteners) {
          try {
            unlisten();
          } catch {
            // ignore
          }
        }
      });
    };
  }, [
    flushPendingProgress,
    isDemoMode,
    loadDownloads,
    openPlaylistDialog,
    scheduleProgressFlush,
    showToast,
    syncPendingPlaylistRequests,
  ]);

  const categoryCounts = useMemo<CategoryCounts>(() => {
    let unf = 0;
    let fin = 0;
    let video = 0;
    let music = 0;
    let compressed = 0;
    let programs = 0;
    let documents = 0;

    for (let i = 0; i < downloads.length; i++) {
      const d = downloads[i];
      if (d.state === 'completed') fin++;
      else unf++;

      const cat = typeOfJob(d);
      if (cat === 'Video') video++;
      else if (cat === 'Music') music++;
      else if (cat === 'Compressed') compressed++;
      else if (cat === 'Programs') programs++;
      else if (cat === 'Documents') documents++;
    }

    return {
      all: downloads.length,
      unf,
      fin,
      Video: video,
      Music: music,
      Compressed: compressed,
      Programs: programs,
      Documents: documents,
    };
  }, [downloads]);

  const { activeCount, totalSpeedBps, completedJobs } = useMemo(() => {
    let active = 0;
    let speed = 0;
    const completed: DownloadJob[] = [];
    for (let i = 0; i < downloads.length; i++) {
      const d = downloads[i];
      if (d.state === 'downloading' || d.state === 'probing') {
        active++;
        speed += d.speed_bps || 0;
      }
      if (d.state === 'completed') {
        completed.push(d);
      }
    }
    return { activeCount: active, totalSpeedBps: speed, completedJobs: completed };
  }, [downloads]);

  const selectedJobs = useMemo(() => {
    return downloads.filter((d) => selectedIds.has(d.id));
  }, [downloads, selectedIds]);

  const canResume = useMemo(() => {
    return selectedJobs.some((j) =>
      ['paused', 'queued', 'failed', 'cancelled'].includes(j.state)
    );
  }, [selectedJobs]);

  const canPause = useMemo(() => {
    return selectedJobs.some((j) => j.state === 'downloading' || j.state === 'probing');
  }, [selectedJobs]);

  const filteredDownloads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    const filtered = downloads.filter((d) => {
      let matchesCategory = false;
      if (currentCategory === 'all') {
        matchesCategory = true;
      } else if (currentCategory === 'unf') {
        matchesCategory = d.state !== 'completed';
      } else if (currentCategory === 'fin') {
        matchesCategory = d.state === 'completed';
      } else {
        matchesCategory = typeOfJob(d) === currentCategory;
      }

      if (!matchesCategory) return false;
      if (!q) return true;
      return d.filename.toLowerCase().includes(q) || d.url.toLowerCase().includes(q);
    });

    if (!sortField) return filtered;

    const dir = sortDir === 'asc' ? 1 : -1;
    return [...filtered].sort((a, b) => {
      switch (sortField) {
        case 'filename':
          return dir * a.filename.localeCompare(b.filename, undefined, { sensitivity: 'base' });
        case 'size':
          return (
            dir *
            ((a.total_bytes ?? a.downloaded_bytes ?? 0) -
              (b.total_bytes ?? b.downloaded_bytes ?? 0))
          );
        case 'status':
          return dir * (computeJobPercent(a) - computeJobPercent(b));
        case 'eta': {
          const ae = a.state === 'downloading' && a.eta_seconds != null ? a.eta_seconds : Number.MAX_SAFE_INTEGER;
          const be = b.state === 'downloading' && b.eta_seconds != null ? b.eta_seconds : Number.MAX_SAFE_INTEGER;
          return dir * (ae - be);
        }
        case 'speed':
          return dir * ((a.speed_bps || 0) - (b.speed_bps || 0));
        case 'date': {
          const dt = parseJobDate(a) - parseJobDate(b);
          if (dt !== 0) return dir * dt;
          return dir * (a.updated_at || a.created_at).localeCompare(b.updated_at || b.created_at);
        }
      }
    });
  }, [downloads, currentCategory, searchQuery, sortField, sortDir]);

  const handleSortHeaderClick = useCallback(
    (field: SortField) => {
      if (sortField === field) {
        setSortDir((prev) => (prev === 'asc' ? 'desc' : 'asc'));
      } else {
        setSortField(field);
        setSortDir(field === 'filename' || field === 'eta' ? 'asc' : 'desc');
      }
    },
    [sortField]
  );

  const handleSortMenuSelect = useCallback((field: SortField | null) => {
    if (field === null) {
      setSortField(null);
      return;
    }
    setSortField(field);
    setSortDir(field === 'filename' || field === 'eta' ? 'asc' : 'desc');
  }, []);

  // Actions
  const handleAddMedia = async (args: {
    url: string;
    formatId: string;
    filename: string;
    destination: string;
    startImmediately: boolean;
    thumbnailUrl?: string | null;
    scheduledAt?: string | null;
  }) => {
    try {
      const job = await invoke<DownloadJob>('create_media_download', {
        args: {
          url: args.url,
          format_id: args.formatId,
          filename: args.filename,
          destination: args.destination || null,
          priority: 'normal',
          thumbnail_url: args.thumbnailUrl || null,
          start_immediately: args.startImmediately,
          scheduled_at: args.scheduledAt || null,
        },
      });

      if (currentCategory === 'fin') {
        setCurrentCategory('all');
      }

      await loadDownloads();
      showToast(
        args.scheduledAt
          ? `Scheduled media download: ${job.filename}`
          : args.startImmediately
            ? `Started media download: ${job.filename}`
            : `Queued media download: ${job.filename}`
      );
    } catch (err: unknown) {
      showToast(`Error adding media download: ${String(err)}`);
      throw err;
    }
  };

  const handleAddUrls = async (
    urls: string[],
    dir: string,
    _connections: number,
    startImmediately: boolean,
    scheduledAt?: string | null
  ) => {
    let createdCount = 0;
    for (const url of urls) {
      try {
        if (isMediaPageUrl(url)) {
          await invoke<DownloadJob>('create_media_download', {
            args: {
              url,
              format_id: 'best',
              filename: null,
              destination: dir || null,
              priority: 'normal',
              thumbnail_url: null,
              start_immediately: startImmediately,
              scheduled_at: scheduledAt || null,
            },
          });
        } else {
          const job = await invoke<DownloadJob>('create_download', {
            url,
            destination: dir || null,
            priority: 'normal',
            referer: null,
            userAgent: null,
            scheduledAt: scheduledAt || null,
          });
          if (!startImmediately && !scheduledAt) {
            await invoke('pause_download', { id: job.id });
          } else if (startImmediately && !scheduledAt) {
            invoke('open_progress_window', { id: job.id, force: false }).catch(() => {});
          }
        }
        createdCount++;
      } catch (err) {
        showToast(`Error adding ${url}: ${String(err)}`);
      }
    }

    if (currentCategory === 'fin') {
      setCurrentCategory('all');
    }
    await loadDownloads();
    showToast(
      scheduledAt
        ? `Scheduled ${createdCount} download(s)`
        : `Added ${createdCount} download(s)`
    );
  };

  const handleTogglePause = useCallback(
    async (job: DownloadJob) => {
      try {
        if (job.state === 'downloading' || job.state === 'probing') {
          await invoke('pause_download', { id: job.id });
          showToast(`Paused ${job.filename}`);
        } else {
          await invoke('resume_download', { id: job.id });
          showToast(`Resumed ${job.filename}`);
        }
      } catch (err) {
        showToast(`Action failed: ${String(err)}`);
      }
    },
    [showToast]
  );

  const handleBulkTogglePause = useCallback(
    async (jobsToToggle: DownloadJob[], forceAction?: 'pause' | 'resume') => {
      if (jobsToToggle.length === 0) return;
      const shouldPause =
        forceAction === 'pause'
          ? true
          : forceAction === 'resume'
            ? false
            : jobsToToggle.some((j) => j.state === 'downloading' || j.state === 'probing');

      let affected = 0;
      for (const job of jobsToToggle) {
        try {
          if (shouldPause) {
            if (job.state === 'downloading' || job.state === 'probing') {
              await invoke('pause_download', { id: job.id });
              affected++;
            }
          } else if (['paused', 'queued', 'failed', 'cancelled'].includes(job.state)) {
            await invoke('resume_download', { id: job.id });
            affected++;
          }
        } catch (err) {
          console.error(err);
        }
      }
      if (affected > 0) {
        showToast(
          shouldPause
            ? `Paused ${affected} download(s)`
            : `Resumed ${affected} download(s)`
        );
      }
    },
    [showToast]
  );

  const handleCancel = async (job: DownloadJob) => {
    try {
      await invoke('cancel_download', { id: job.id });
      showToast(`Cancelled ${job.filename}`);
    } catch (err) {
      showToast(`Cancel failed: ${String(err)}`);
    }
  };

  const handleReschedule = async (job: DownloadJob) => {
    const defaultVal = job.scheduled_at
      ? new Date(job.scheduled_at).toISOString().slice(0, 16)
      : new Date(Date.now() + 3600000).toISOString().slice(0, 16);

    const promptValue = window.prompt(
      'Enter new scheduled date and time (YYYY-MM-DDTHH:MM), or leave empty to clear schedule and queue for download:',
      defaultVal
    );
    if (promptValue === null) return;

    let isoScheduled: string | null = null;
    if (promptValue.trim() !== '') {
      const parsed = new Date(promptValue.trim());
      if (isNaN(parsed.getTime())) {
        showToast('Invalid date/time format.');
        return;
      }
      if (parsed.getTime() <= Date.now()) {
        showToast('Scheduled time must be in the future.');
        return;
      }
      isoScheduled = parsed.toISOString();
    }

    try {
      await invoke('reschedule_download', { id: job.id, scheduledAt: isoScheduled });
      await loadDownloads();
      showToast(
        isoScheduled
          ? `Rescheduled ${job.filename}`
          : `Schedule cleared — queued ${job.filename}`
      );
    } catch (err) {
      showToast(`Error rescheduling: ${String(err)}`);
    }
  };

  const handleOpenProgress = useCallback(async (job: DownloadJob) => {
    try {
      await invoke('open_progress_window', { id: job.id });
    } catch {
      setProgressJobId(job.id);
    }
  }, []);

  const handleStopAll = useCallback(async () => {
    const active = downloads.filter(
      (d) => d.state === 'downloading' || d.state === 'probing'
    );
    for (const job of active) {
      try {
        await invoke('pause_download', { id: job.id });
      } catch (err) {
        console.error(err);
      }
    }
    showToast('Stopped all active downloads');
  }, [downloads, showToast]);

  const handleStartQueue = useCallback(async () => {
    const paused = downloads.filter(
      (d) => d.state === 'paused' || d.state === 'queued'
    );
    for (const job of paused) {
      try {
        await invoke('resume_download', { id: job.id });
      } catch (err) {
        console.error(err);
      }
    }
    showToast('Started download queue');
  }, [downloads, showToast]);

  const handleBulkDelete = async (jobsToDelete: DownloadJob[], deleteFiles: boolean) => {
    const ids = jobsToDelete.map((j) => j.id);
    if (ids.length === 0) return;
    try {
      if (ids.length === 1) {
        await invoke('delete_download', { id: ids[0], deleteFiles });
      } else {
        await invoke('delete_downloads', { ids, deleteFiles });
      }
      const idSet = new Set(ids);
      setDownloads((prev) => prev.filter((d) => !idSet.has(d.id)));
      setSelectedIds((prev) => {
        const next = new Set(prev);
        ids.forEach((id) => next.delete(id));
        return next;
      });
      showToast(`Deleted ${ids.length} download(s)`);
    } catch (err) {
      showToast(`Delete failed: ${String(err)}`);
    }
  };

  const handleRetry = useCallback(
    async (job: DownloadJob) => {
      try {
        await invoke('retry_download', { id: job.id });
        showToast(`Restarted ${job.filename}`);
      } catch (err) {
        showToast(`Retry failed: ${String(err)}`);
      }
    },
    [showToast]
  );

  const handleOpenFile = useCallback(
    async (path: string) => {
      try {
        await invoke('open_file', { path });
      } catch (err) {
        showToast(`Could not open file: ${String(err)}`);
      }
    },
    [showToast]
  );

  const handleOpenFolder = useCallback(
    async (path: string) => {
      try {
        await invoke('open_folder', { path });
      } catch (err) {
        showToast(`Could not open folder: ${String(err)}`);
      }
    },
    [showToast]
  );

  const handleVerifyChecksum = useCallback(
    async (path: string) => {
      showToast('Calculating SHA-256 checksum...');
      try {
        const hash = await invoke<string>('verify_checksum', { path });
        showToast(`SHA-256: ${hash.substring(0, 16)}...`);
      } catch (err) {
        showToast(`Checksum error: ${String(err)}`);
      }
    },
    [showToast]
  );

  const handleCopyUrl = useCallback(
    (url: string) => {
      try {
        navigator.clipboard.writeText(url);
        showToast('Address copied to clipboard');
      } catch {
        showToast('Could not copy to clipboard');
      }
    },
    [showToast]
  );

  const handleOpenDataFolder = useCallback(async () => {
    try {
      await invoke('open_data_folder');
    } catch (err) {
      showToast(`Could not open folder: ${String(err)}`);
    }
  }, [showToast]);

  const handleExitApp = useCallback(async () => {
    try {
      await invoke('exit_app', { force: false });
    } catch (err) {
      if (String(err).includes('active_downloads')) {
        const confirmed = window.confirm(
          'Active downloads are still in progress. Exit TORI Download Manager anyway?'
        );
        if (confirmed) {
          await invoke('exit_app', { force: true }).catch(() => { });
        }
      } else {
        showToast(`Exit failed: ${String(err)}`);
      }
    }
  }, [showToast]);

  const handleRowSelect = useCallback(
    (e: React.MouseEvent, id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        if (e.shiftKey && (e.ctrlKey || e.metaKey)) {
          if (!lastFocusedId || !filteredDownloads.some((d) => d.id === lastFocusedId)) {
            next.add(id);
          } else {
            const fromIdx = filteredDownloads.findIndex((d) => d.id === lastFocusedId);
            const toIdx = filteredDownloads.findIndex((d) => d.id === id);
            const start = Math.min(fromIdx, toIdx);
            const end = Math.max(fromIdx, toIdx);
            for (let i = start; i <= end; i++) {
              next.add(filteredDownloads[i].id);
            }
          }
          return next;
        }

        if (e.shiftKey) {
          const rangeSet = new Set<string>();
          if (!lastFocusedId || !filteredDownloads.some((d) => d.id === lastFocusedId)) {
            rangeSet.add(id);
          } else {
            const fromIdx = filteredDownloads.findIndex((d) => d.id === lastFocusedId);
            const toIdx = filteredDownloads.findIndex((d) => d.id === id);
            const start = Math.min(fromIdx, toIdx);
            const end = Math.max(fromIdx, toIdx);
            for (let i = start; i <= end; i++) {
              rangeSet.add(filteredDownloads[i].id);
            }
          }
          return rangeSet;
        }

        if (e.ctrlKey || e.metaKey) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        }

        return new Set([id]);
      });

      setLastFocusedId(id);
    },
    [lastFocusedId, filteredDownloads]
  );

  const handleRowContextMenu = useCallback((e: React.MouseEvent, job: DownloadJob) => {
    e.preventDefault();
    setSelectedIds((prev) => {
      if (prev.has(job.id)) {
        return prev;
      }
      setLastFocusedId(job.id);
      return new Set([job.id]);
    });
    setContextMenu({ x: e.clientX, y: e.clientY, job });
  }, []);

  const handleTableBackgroundClick = useCallback((e: React.MouseEvent) => {
    if ((e.target as HTMLElement).closest('.tr')) {
      return;
    }
    setSelectedIds(new Set());
    setLastFocusedId(null);
  }, []);

  // Keyboard shortcuts & table navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAddModalOpen(false);
        setPlaylistModalState(null);
        setProgressJobId(null);
        setIsSettingsModalOpen(false);
        setDeleteConfirmJobs(null);
        setContextMenu(null);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'n' || e.key === 'N')) {
        e.preventDefault();
        setIsAddModalOpen(true);
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F')) {
        e.preventDefault();
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
        return;
      }

      if ((e.ctrlKey || e.metaKey) && e.key === ',') {
        e.preventDefault();
        setSettingsInitialTab('engine');
        setIsSettingsModalOpen(true);
        return;
      }

      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName)) {
        return;
      }

      if ((e.ctrlKey || e.metaKey) && (e.key === 'a' || e.key === 'A')) {
        e.preventDefault();
        const allIds = new Set(filteredDownloads.map((d) => d.id));
        setSelectedIds(allIds);
        return;
      }

      const list = filteredDownloads;
      const currentIndex = lastFocusedId
        ? list.findIndex((x) => x.id === lastFocusedId)
        : -1;

      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const nextIdx = Math.min(list.length - 1, currentIndex + 1);
        if (nextIdx >= 0 && nextIdx < list.length) {
          const nextId = list[nextIdx].id;
          if (e.shiftKey) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.add(nextId);
              return next;
            });
          } else {
            setSelectedIds(new Set([nextId]));
          }
          setLastFocusedId(nextId);
        }
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prevIdx = Math.max(0, currentIndex - 1);
        if (prevIdx >= 0 && prevIdx < list.length) {
          const prevId = list[prevIdx].id;
          if (e.shiftKey) {
            setSelectedIds((prev) => {
              const next = new Set(prev);
              next.add(prevId);
              return next;
            });
          } else {
            setSelectedIds(new Set([prevId]));
          }
          setLastFocusedId(prevId);
        }
      } else if (e.key === ' ' && selectedJobs.length > 0) {
        e.preventDefault();
        handleBulkTogglePause(selectedJobs);
      } else if (e.key === 'Delete' && selectedJobs.length > 0) {
        e.preventDefault();
        setDeleteConfirmJobs(selectedJobs);
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [filteredDownloads, handleBulkTogglePause, lastFocusedId, selectedJobs]);

  const progressJob = useMemo(() => {
    return downloads.find((d) => d.id === progressJobId) || null;
  }, [downloads, progressJobId]);

  const singleSelected = selectedJobs.length === 1 ? selectedJobs[0] : null;

  return (
    <div className="win" id="main">
      <TitleBar title="Tori Download Manager" />

      <MenuBar
        selectedCount={selectedJobs.length}
        singleSelectedComplete={!!singleSelected && singleSelected.state === 'completed'}
        hasSingleSelection={!!singleSelected}
        canResume={canResume}
        canPause={canPause}
        hasActiveDownloads={activeCount > 0}
        hasCompletedDownloads={completedJobs.length > 0}
        currentCategory={currentCategory}
        sortField={sortField}
        currentTheme={settings.theme}
        isModalOpen={
          isAddModalOpen ||
          isSettingsModalOpen ||
          !!playlistModalState ||
          !!deleteConfirmJobs ||
          !!progressJobId ||
          !!availableUpdate
        }
        onAdd={() => setIsAddModalOpen(true)}
        onResumeSelected={() => handleBulkTogglePause(selectedJobs, 'resume')}
        onPauseSelected={() => handleBulkTogglePause(selectedJobs, 'pause')}
        onStopAll={handleStopAll}
        onStartQueue={handleStartQueue}
        onOpenFile={() => singleSelected && handleOpenFile(singleSelected.target_path)}
        onOpenFolder={() => singleSelected && handleOpenFolder(singleSelected.target_path)}
        onOpenProgress={() => singleSelected && handleOpenProgress(singleSelected)}
        onCopyUrl={() => singleSelected && handleCopyUrl(singleSelected.url)}
        onRetrySelected={() => singleSelected && handleRetry(singleSelected)}
        onVerifyChecksum={() => singleSelected && handleVerifyChecksum(singleSelected.target_path)}
        onDeleteSelected={() => selectedJobs.length > 0 && setDeleteConfirmJobs(selectedJobs)}
        onClearCompleted={() => completedJobs.length > 0 && setDeleteConfirmJobs(completedJobs)}
        onSelectAll={() => setSelectedIds(new Set(filteredDownloads.map((d) => d.id)))}
        onClearSelection={() => {
          setSelectedIds(new Set());
          setLastFocusedId(null);
        }}
        onSelectCategory={setCurrentCategory}
        onSortBy={handleSortMenuSelect}
        onChangeTheme={(theme) => handleUpdateSettings({ ...settingsRef.current, theme })}
        onOpenSettings={(tab = 'engine') => {
          setSettingsInitialTab(tab);
          setIsSettingsModalOpen(true);
        }}
        onOpenDataFolder={handleOpenDataFolder}
        onExit={handleExitApp}
      />

      <ToolBar
        onAdd={() => setIsAddModalOpen(true)}
        onResume={() => handleBulkTogglePause(selectedJobs, 'resume')}
        onPause={() => handleBulkTogglePause(selectedJobs, 'pause')}
        onStopAll={handleStopAll}
        onDelete={() => selectedJobs.length > 0 && setDeleteConfirmJobs(selectedJobs)}
        onStartQueue={handleStartQueue}
        onOpenSettings={() => {
          setSettingsInitialTab('engine');
          setIsSettingsModalOpen(true);
        }}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCount={selectedJobs.length}
        canResume={canResume}
        canPause={canPause}
        searchInputRef={searchInputRef}
      />

      <div id="body">
        <SideBar
          currentCategory={currentCategory}
          onSelectCategory={setCurrentCategory}
          allCount={categoryCounts.all}
          unfCount={categoryCounts.unf}
          finCount={categoryCounts.fin}
          videoCount={categoryCounts.Video}
          musicCount={categoryCounts.Music}
          compressedCount={categoryCounts.Compressed}
          programsCount={categoryCounts.Programs}
          documentsCount={categoryCounts.Documents}
        />

        <DownloadTable
          downloads={filteredDownloads}
          selectedIds={selectedIds}
          focusedId={lastFocusedId}
          sortField={sortField}
          sortDir={sortDir}
          onSortChange={handleSortHeaderClick}
          onSelect={handleRowSelect}
          onOpenProgress={handleOpenProgress}
          onContextMenu={handleRowContextMenu}
          onBackgroundClick={handleTableBackgroundClick}
        />
      </div>

      <StatusBar
        activeCount={activeCount}
        totalSpeedBps={totalSpeedBps}
        visibleCount={filteredDownloads.length}
        totalCount={downloads.length}
        isExtensionConnected={isExtensionConnected}
        statusMessage={toastMessage}
      />

      {/* ================= MODALS & POPUPS ================= */}
      {isAddModalOpen && (
        <AddDownloadModal
          defaultDir={settings.dir}
          defaultConnections={settings.con}
          onClose={() => setIsAddModalOpen(false)}
          onSubmit={handleAddUrls}
          onSubmitMedia={handleAddMedia}
          onOpenPlaylist={(url) => {
            openPlaylistDialog(url);
          }}
        />
      )}

      {playlistModalState !== null && (
        <PlaylistModal
          initialUrl={playlistModalState.url}
          requestId={playlistModalState.requestId}
          supersededRequestIds={playlistModalState.supersededRequestIds}
          requestNonce={playlistModalState.nonce}
          defaultDir={settings.dir}
          onClose={() => setPlaylistModalState(null)}
          onEnqueued={(count) => {
            loadDownloads();
            showToast(`Enqueued ${count} videos from playlist`);
          }}
        />
      )}

      {progressJob && (
        <ProgressModal
          job={progressJob}
          onClose={() => setProgressJobId(null)}
          onTogglePause={handleTogglePause}
          onCancel={handleCancel}
          onOpenFile={handleOpenFile}
        />
      )}

      {availableUpdate && !isSettingsModalOpen && (
        <div
          style={{
            position: 'fixed',
            top: 42,
            right: 20,
            background: 'var(--blue)',
            color: '#fff',
            padding: '8px 14px',
            borderRadius: 8,
            boxShadow: '0 4px 14px rgba(0,0,0,0.25)',
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            fontSize: 12,
            fontWeight: 500,
            zIndex: 9999,
            cursor: 'pointer',
          }}
          onClick={() => {
            setSettingsInitialTab('about');
            setIsSettingsModalOpen(true);
          }}
        >
          <span>✨ New version available: v{availableUpdate.version}</span>
          <button
            type="button"
            style={{
              background: 'rgba(255,255,255,0.25)',
              border: 'none',
              borderRadius: 4,
              color: '#fff',
              padding: '2px 8px',
              fontSize: 11,
              cursor: 'pointer',
            }}
          >
            Review
          </button>
        </div>
      )}

      {isSettingsModalOpen && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
          initialTab={settingsInitialTab}
          onClose={() => setIsSettingsModalOpen(false)}
        />
      )}

      {deleteConfirmJobs && (
        <DeleteConfirmModal
          jobs={deleteConfirmJobs}
          onConfirm={handleBulkDelete}
          onClose={() => setDeleteConfirmJobs(null)}
        />
      )}

      {contextMenu && (
        <ContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          job={contextMenu.job}
          selectedJobs={selectedJobs}
          onClose={() => setContextMenu(null)}
          onOpenProgress={handleOpenProgress}
          onTogglePause={handleTogglePause}
          onBulkTogglePause={handleBulkTogglePause}
          onOpenFolder={handleOpenFolder}
          onOpenFile={handleOpenFile}
          onCopyUrl={handleCopyUrl}
          onRetry={handleRetry}
          onVerifyChecksum={handleVerifyChecksum}
          onDelete={(jobs) => setDeleteConfirmJobs(jobs)}
          onReschedule={handleReschedule}
        />
      )}

      {toastMessage && <div className="toast">{toastMessage}</div>}
    </div>
  );
}
export default App;
