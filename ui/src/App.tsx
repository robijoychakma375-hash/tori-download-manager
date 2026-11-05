import { useEffect, useState, useMemo, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import './App.css';
import type { AppSettings, CategoryKey, DownloadEvent, DownloadJob } from './types';
import { TitleBar } from './components/TitleBar';
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
};

function loadStoredSettings(): AppSettings {
  try {
    const raw = localStorage.getItem('tori_settings_v2');
    if (raw) {
      return { ...DEFAULT_SETTINGS, ...JSON.parse(raw) };
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

export function App() {
  const urlParams = useMemo(() => new URLSearchParams(window.location.search), []);
  const windowMode = urlParams.get('window');
  const windowJobId = urlParams.get('id');

  if (windowMode === 'toast' || windowMode === 'progress') {
    document.documentElement.classList.add('toast-mode');
    return <DownloadToast initialId={windowJobId || undefined} />;
  }

  const [downloads, setDownloads] = useState<DownloadJob[]>([]);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [lastFocusedId, setLastFocusedId] = useState<string | null>(null);
  const [currentCategory, setCurrentCategory] = useState<CategoryKey>('all');
  const [searchQuery, setSearchQuery] = useState('');
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
  const [isExtensionConnected, setIsExtensionConnected] = useState(false);

  // Modals & popups
  const [isAddModalOpen, setIsAddModalOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('modal') === 'add';
    } catch {
      return false;
    }
  });
  const [playlistModalUrl, setPlaylistModalUrl] = useState<string | null>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('modal') === 'playlist') {
        return 'https://www.youtube.com/playlist?list=PL6B3937A5D230E335';
      }
    } catch {}
    return null;
  });
  const [progressJobId, setProgressJobId] = useState<string | null>(null);
  const [isSettingsModalOpen, setIsSettingsModalOpen] = useState(() => {
    try {
      return new URLSearchParams(window.location.search).get('modal') === 'settings';
    } catch {
      return false;
    }
  });
  const [deleteConfirmJobs, setDeleteConfirmJobs] = useState<DownloadJob[] | null>(() => {
    try {
      if (new URLSearchParams(window.location.search).get('modal') === 'delete') {
        return DEMO_DOWNLOADS.slice(0, 3);
      }
    } catch {}
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

  // Sync theme and accent with document element
  useEffect(() => {
    const applyTheme = () => {
      const isDark =
        settings.theme === 'dark' ||
        (settings.theme === 'system' &&
          window.matchMedia('(prefers-color-scheme: dark)').matches);
      document.documentElement.dataset.theme = isDark ? 'dark' : 'light';
      document.documentElement.dataset.accent = settings.accent || 'indigo';
    };

    applyTheme();
    const mql = window.matchMedia('(prefers-color-scheme: dark)');
    const listener = () => {
      if (settings.theme === 'system') applyTheme();
    };
    mql.addEventListener('change', listener);
    return () => mql.removeEventListener('change', listener);
  }, [settings.theme, settings.accent]);

  // Persist settings to localStorage and push to Rust backend engine
  const handleUpdateSettings = (newSettings: AppSettings) => {
    setSettings(newSettings);
    try {
      localStorage.setItem('tori_settings_v2', JSON.stringify(newSettings));
    } catch (err) {
      console.error('Failed to store settings:', err);
    }
    invoke('update_engine_settings', { settings: newSettings }).catch((err) => {
      console.error('Failed to push settings to Rust engine:', err);
    });
  };

  // Synchronize settings with Rust backend on startup
  useEffect(() => {
    const syncSettings = async () => {
      try {
        const backendSettings = await invoke<AppSettings | null>('get_engine_settings');
        if (backendSettings) {
          setSettings((prev) => {
            const merged = { ...prev, ...backendSettings };
            try {
              localStorage.setItem('tori_settings_v2', JSON.stringify(merged));
            } catch {
              // ignore
            }
            return merged;
          });
        } else {
          await invoke('update_engine_settings', { settings });
        }
      } catch (err) {
        console.error('Failed to sync engine settings:', err);
      }
    };
    syncSettings();
  }, []);

  // Load downloads from SQLite backend (strictly real data; demo items only if explicitly ?demo=1)
  const loadDownloads = useCallback(async () => {
    if (urlParams.get('demo') === '1') {
      setDownloads(DEMO_DOWNLOADS);
      const sel = urlParams.get('sel') === 'multi'
        ? new Set(DEMO_DOWNLOADS.slice(0, 3).map((d) => d.id))
        : new Set(DEMO_DOWNLOADS.length > 0 ? [DEMO_DOWNLOADS[0].id] : []);
      setSelectedIds(sel);
      return;
    }
    try {
      const list = await invoke<DownloadJob[]>('list_downloads');
      setDownloads(list || []);
      setSelectedIds((prev) => (prev.size > 0 ? prev : new Set(list && list.length > 0 ? [list[0].id] : [])));
    } catch (err) {
      console.error('Failed to load downloads from SQLite:', err);
      setDownloads([]);
    }
  }, [urlParams]);

  // Initial setup: downloads, default download folder, extension check
  useEffect(() => {
    loadDownloads();

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

    // Listen to real-time events from Rust engine EventBus
    const unlistenPromise = listen<DownloadEvent>('download-event', (event) => {
      const payload = event.payload;

      if (payload.type === 'Progress') {
        const p = payload.payload;
        setDownloads((prev) => {
          const exists = prev.some((j) => j.id === p.id);
          if (!exists) {
            loadDownloads();
            return prev;
          }
          return prev.map((job) => {
            if (job.id === p.id) {
              return {
                ...job,
                downloaded_bytes: p.downloaded_bytes,
                total_bytes: p.total_bytes ?? job.total_bytes,
                speed_bps: p.speed_bps,
                eta_seconds: p.eta_seconds,
                state: p.state,
                error_message: p.error_message ?? job.error_message,
              };
            }
            return job;
          });
        });
      } else if (payload.type === 'StateChanged') {
        const sc = payload.payload;
        setDownloads((prev) => {
          const exists = prev.some((j) => j.id === sc.id);
          if (!exists) {
            loadDownloads();
            return prev;
          }
          return prev.map((job) => {
            if (job.id === sc.id) {
              return {
                ...job,
                state: sc.state,
                error_message: sc.error,
                speed_bps:
                  sc.state === 'completed' || sc.state === 'paused'
                    ? 0
                    : job.speed_bps,
              };
            }
            return job;
          });
        });

        if (sc.state === 'completed' || sc.state === 'failed' || sc.state === 'downloading') {
          loadDownloads();
        }
      }
    });

    return () => {
      clearInterval(extInterval);
      unlistenPromise.then((unlisten) => unlisten());
    };
  }, [loadDownloads]);

  // Selected downloads reference
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

  // Filtered downloads for current category & search
  const filteredDownloads = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return downloads.filter((d) => {
      // Category filter
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

      // Search filter
      const matchesSearch =
        !q ||
        d.filename.toLowerCase().includes(q) ||
        d.url.toLowerCase().includes(q);

      return matchesCategory && matchesSearch;
    });
  }, [downloads, currentCategory, searchQuery]);

  // Actions
  const handleAddMedia = async (args: {
    url: string;
    formatId: string;
    filename: string;
    destination: string;
    startImmediately: boolean;
    thumbnailUrl?: string | null;
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
        },
      });

      if (currentCategory === 'fin') {
        setCurrentCategory('all');
      }

      await loadDownloads();
      showToast(
        args.startImmediately
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
    startImmediately: boolean
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
            },
          });
        } else {
          const job = await invoke<DownloadJob>('create_download', {
            url,
            destination: dir || null,
            priority: 'normal',
          });
          if (!startImmediately) {
            await invoke('pause_download', { id: job.id });
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
    showToast(`Added ${createdCount} download(s)`);
  };

  const handleTogglePause = async (job: DownloadJob) => {
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
  };

  const handleBulkTogglePause = async (jobsToToggle: DownloadJob[]) => {
    if (jobsToToggle.length === 0) return;
    const isAnyDownloading = jobsToToggle.some(
      (j) => j.state === 'downloading' || j.state === 'probing'
    );
    for (const job of jobsToToggle) {
      try {
        if (isAnyDownloading) {
          if (job.state === 'downloading' || job.state === 'probing') {
            await invoke('pause_download', { id: job.id });
          }
        } else {
          if (['paused', 'queued', 'failed', 'cancelled'].includes(job.state)) {
            await invoke('resume_download', { id: job.id });
          }
        }
      } catch (err) {
        console.error(err);
      }
    }
    showToast(
      isAnyDownloading
        ? `Paused ${jobsToToggle.length} download(s)`
        : `Resumed ${jobsToToggle.length} download(s)`
    );
  };

  const handleCancel = async (job: DownloadJob) => {
    try {
      await invoke('cancel_download', { id: job.id });
      showToast(`Cancelled ${job.filename}`);
    } catch (err) {
      showToast(`Cancel failed: ${String(err)}`);
    }
  };

  const handleOpenProgress = async (job: DownloadJob) => {
    try {
      await invoke('open_progress_window', { id: job.id });
    } catch {
      setProgressJobId(job.id);
    }
  };

  const handleStopAll = async () => {
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
    showToast(`Stopped all active downloads`);
  };

  const handleStartQueue = async () => {
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
    showToast(`Started download queue`);
  };

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

  const handleRetry = async (job: DownloadJob) => {
    try {
      await invoke('retry_download', { id: job.id });
      showToast(`Restarted ${job.filename}`);
    } catch (err) {
      showToast(`Retry failed: ${String(err)}`);
    }
  };

  const handleOpenFile = async (path: string) => {
    try {
      await invoke('open_file', { path });
    } catch (err) {
      showToast(`Could not open file: ${String(err)}`);
    }
  };

  const handleOpenFolder = async (path: string) => {
    try {
      await invoke('open_folder', { path });
    } catch (err) {
      showToast(`Could not open folder: ${String(err)}`);
    }
  };

  const handleVerifyChecksum = async (path: string) => {
    showToast('Calculating SHA-256 checksum...');
    try {
      const hash = await invoke<string>('verify_checksum', { path });
      showToast(`SHA-256: ${hash.substring(0, 16)}...`);
    } catch (err) {
      showToast(`Checksum error: ${String(err)}`);
    }
  };

  const handleCopyUrl = (url: string) => {
    try {
      navigator.clipboard.writeText(url);
      showToast('Address copied to clipboard');
    } catch {
      showToast('Could not copy to clipboard');
    }
  };

  const handleRowSelect = useCallback(
    (e: React.MouseEvent, id: string) => {
      setSelectedIds((prev) => {
        const next = new Set(prev);

        // 1. Shift + (Ctrl/Cmd) -> Range addition
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

        // 2. Shift alone -> Continuous range selection (replacing selection)
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

        // 3. Ctrl / Cmd alone -> Toggle individual selection
        if (e.ctrlKey || e.metaKey) {
          if (next.has(id)) {
            next.delete(id);
          } else {
            next.add(id);
          }
          return next;
        }

        // 4. Normal click -> Select single item exclusively
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

  // Keyboard navigation
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setIsAddModalOpen(false);
        setPlaylistModalUrl(null);
        setProgressJobId(null);
        setIsSettingsModalOpen(false);
        setDeleteConfirmJobs(null);
        setContextMenu(null);
        setSelectedIds(new Set());
        return;
      }

      if (/INPUT|TEXTAREA|SELECT/.test((e.target as HTMLElement)?.tagName)) {
        return;
      }

      // Ctrl + A -> Select all visible downloads
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
            setLastFocusedId(nextId);
          }
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
            setLastFocusedId(prevId);
          }
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
  }, [filteredDownloads, lastFocusedId, selectedJobs]);

  const progressJob = useMemo(() => {
    return downloads.find((d) => d.id === progressJobId) || null;
  }, [downloads, progressJobId]);

  return (
    <div className="win" id="main">
      <TitleBar title="Tori Download Manager" />

      <ToolBar
        onAdd={() => setIsAddModalOpen(true)}
        onResume={() => handleBulkTogglePause(selectedJobs)}
        onPause={() => handleBulkTogglePause(selectedJobs)}
        onStopAll={handleStopAll}
        onDelete={() => selectedJobs.length > 0 && setDeleteConfirmJobs(selectedJobs)}
        onStartQueue={handleStartQueue}
        onOpenSettings={() => setIsSettingsModalOpen(true)}
        searchQuery={searchQuery}
        onSearchChange={setSearchQuery}
        selectedCount={selectedJobs.length}
        canResume={canResume}
        canPause={canPause}
      />

      <div id="body">
        <SideBar
          currentCategory={currentCategory}
          onSelectCategory={setCurrentCategory}
          downloads={downloads}
        />

        <DownloadTable
          downloads={filteredDownloads}
          selectedIds={selectedIds}
          onSelect={handleRowSelect}
          onOpenProgress={handleOpenProgress}
          onContextMenu={handleRowContextMenu}
          onBackgroundClick={handleTableBackgroundClick}
        />
      </div>

      <StatusBar
        downloads={downloads}
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
            setIsAddModalOpen(false);
            setPlaylistModalUrl(url);
          }}
        />
      )}

      {playlistModalUrl !== null && (
        <PlaylistModal
          initialUrl={playlistModalUrl}
          defaultDir={settings.dir}
          onClose={() => setPlaylistModalUrl(null)}
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

      {isSettingsModalOpen && (
        <SettingsModal
          settings={settings}
          onUpdateSettings={handleUpdateSettings}
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
        />
      )}

      {toastMessage && <div className="toast">{toastMessage}</div>}
    </div>
  );
}
export default App;
