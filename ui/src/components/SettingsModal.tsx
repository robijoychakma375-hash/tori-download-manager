import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { TitleBar } from './TitleBar';
import { ToggleSwitch } from './ToggleSwitch';
import { SettingsTabIcon, ToriLogoIcon } from './Icons';
import { ExternalToolsPanel } from './ExternalToolsPanel';
import type { AppSettings } from '../types';
import {
  fetchAppVersion,
  fetchThirdPartyLicenses,
  openExternalUrl,
  checkForUpdate,
  downloadUpdate,
  installUpdateSafe,
  type UpdateStatus,
} from '../updater';
import type { Update } from '@tauri-apps/plugin-updater';

interface SettingsModalProps {
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onClose: () => void;
  initialTab?: TabKey;
}

type TabKey = 'appearance' | 'engine' | 'integration' | 'tools' | 'about';

interface NavTab {
  key: TabKey;
  label: string;
}

const TABS: NavTab[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'engine', label: 'Download Engine' },
  { key: 'integration', label: 'Browser Integration' },
  { key: 'tools', label: 'External Tools' },
  { key: 'about', label: 'About' },
];

// Official website URL (hidden until public website is launched and verified)
const OFFICIAL_WEBSITE_URL: string | null = null;

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onUpdateSettings,
  onClose,
  initialTab,
}) => {
  const [currentTab, setCurrentTab] = useState<TabKey>(() => {
    try {
      const paramTab = new URLSearchParams(window.location.search).get('tab');
      if (paramTab && ['appearance', 'engine', 'integration', 'tools', 'about'].includes(paramTab)) {
        return paramTab as TabKey;
      }
    } catch {
      // ignore
    }
    return initialTab || 'engine';
  });
  const [appVersion, setAppVersion] = useState<string>('1.0.8');
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({
    state: 'idle',
    currentVersion: '1.0.8',
    downloadedBytes: 0,
    totalBytes: 0,
  });
  const [currentUpdate, setCurrentUpdate] = useState<Update | null>(null);
  const [showLicensesModal, setShowLicensesModal] = useState(false);
  const [licensesContent, setLicensesContent] = useState<string | null>(null);
  const [showNotesModal, setShowNotesModal] = useState(false);
  const [hostStatus, setHostStatus] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const settingsRef = React.useRef(settings);
  const onUpdateRef = React.useRef(onUpdateSettings);

  useEffect(() => {
    settingsRef.current = settings;
    onUpdateRef.current = onUpdateSettings;
  }, [settings, onUpdateSettings]);

  useEffect(() => {
    fetchAppVersion().then((ver) => {
      setAppVersion(ver);
      setUpdateStatus((prev) => ({ ...prev, currentVersion: ver }));
    });
  }, []);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settingsRef.current, [key]: value };
    settingsRef.current = updated;
    onUpdateRef.current(updated);
  };

  const handleCheckForUpdates = async () => {
    setUpdateStatus((prev) => ({ ...prev, state: 'checking', errorMessage: undefined }));
    update('lastUpdateCheck', Date.now());

    const result = await checkForUpdate();
    if (result.error) {
      setUpdateStatus((prev) => ({
        ...prev,
        state: 'error',
        errorMessage: result.error,
      }));
      return;
    }

    if (result.available && result.update) {
      setCurrentUpdate(result.update);
      setUpdateStatus((prev) => ({
        ...prev,
        state: 'available',
        newVersion: result.update?.version,
        releaseDate: result.update?.date,
        releaseNotes: result.update?.body,
      }));
    } else {
      setCurrentUpdate(null);
      setUpdateStatus((prev) => ({
        ...prev,
        state: 'up_to_date',
      }));
    }
  };

  const handleDownloadAndInstall = async () => {
    if (!currentUpdate) return;
    setUpdateStatus((prev) => ({ ...prev, state: 'downloading', downloadedBytes: 0, totalBytes: 0 }));

    try {
      await downloadUpdate(currentUpdate, (downloaded, total) => {
        setUpdateStatus((prev) => ({
          ...prev,
          state: 'downloading',
          downloadedBytes: downloaded,
          totalBytes: total,
        }));
      });

      const installRes = await installUpdateSafe(currentUpdate);
      if (!installRes.success) {
        if (installRes.activeDownloads && installRes.activeDownloads > 0) {
          setUpdateStatus((prev) => ({
            ...prev,
            state: 'blocked_active_downloads',
            activeDownloadsCount: installRes.activeDownloads,
          }));
        } else {
          setUpdateStatus((prev) => ({
            ...prev,
            state: 'error',
            errorMessage: installRes.error || 'Failed to install update',
          }));
        }
      } else {
        setUpdateStatus((prev) => ({ ...prev, state: 'ready' }));
      }
    } catch (err) {
      setUpdateStatus((prev) => ({
        ...prev,
        state: 'error',
        errorMessage: String(err),
      }));
    }
  };

  const handleRemindLater = () => {
    update('remindLaterUntil', Date.now() + 24 * 60 * 60 * 1000);
    setUpdateStatus((prev) => ({ ...prev, state: 'idle' }));
    flash('Update reminder deferred for 24 hours');
  };

  const handleOpenLicenses = async () => {
    if (!licensesContent) {
      const text = await fetchThirdPartyLicenses();
      setLicensesContent(text);
    }
    setShowLicensesModal(true);
  };

  const handleOpenDataFolder = async () => {
    try {
      await invoke('open_data_folder');
    } catch (err) {
      console.error(err);
    }
  };

  const handleRegisterHost = async () => {
    try {
      await invoke('register_native_host');
      setHostStatus('Native host registered successfully!');
      setTimeout(() => setHostStatus(null), 3000);
    } catch (err) {
      setHostStatus(`Registration failed: ${String(err)}`);
    }
  };

  const handleCycleProxy = () => {
    const list = ['none', 'system', 'manual'];
    const curIdx = list.indexOf(settings.proxy || 'none');
    const next = list[(curIdx + 1) % list.length];
    update('proxy', next);
  };

  const handleCycleDns = () => {
    const list = ['System DNS', 'Cloudflare (1.1.1.1)', 'Google (8.8.8.8)'];
    const curIdx = list.indexOf(settings.dns || 'System DNS');
    const next = list[(curIdx + 1) % list.length];
    update('dns', next);
  };

  useEffect(() => {
    if (currentTab !== 'integration') return;
    let active = true;
    invoke<{ port: number; active_port: number; token: string }>('get_browser_integration_info')
      .then((info) => {
        if (!active || !info) return;
        const cur = settingsRef.current;
        const nextKey = info.token || cur.key;
        const nextPort = info.active_port || cur.port;
        if (nextKey !== cur.key || nextPort !== cur.port) {
          onUpdateRef.current({
            ...cur,
            key: nextKey,
            port: nextPort,
          });
        }
      })
      .catch((err) => console.warn('Failed to load integration info:', err));
    return () => {
      active = false;
    };
  }, [currentTab]);

  const handleCopyKey = () => {
    try {
      navigator.clipboard.writeText(settings.key || '');
      flash('API key copied');
    } catch {
      flash('Could not copy key');
    }
  };

  const handleRegenKey = async () => {
    try {
      const newKey = await invoke<string>('regenerate_pairing_token');
      update('key', newKey);
      flash('New API key generated');
    } catch {
      flash('Failed to regenerate key');
    }
  };

  const proxyLabel = () => {
    if (settings.proxy === 'system') return 'System proxy will be used';
    if (settings.proxy === 'manual') return 'Manual proxy configured';
    return 'No Proxy will be used';
  };

  return (
    <>
      <div id="dim" onClick={onClose} />
      <div
        className="win pop"
        id="setw"
        style={{
          width: 820,
          height: 650,
          maxWidth: 'calc(100vw - 24px)',
          maxHeight: 'calc(100vh - 24px)',
        }}
      >
        <TitleBar title="Settings" onClose={onClose} isModal />

        <div className="ptabs" id="ptabsrow">
          {TABS.map(({ key, label }) => {
            const isSelected = currentTab === key;
            return (
              <button
                type="button"
                key={key}
                data-tab={key}
                className={`pt ${isSelected ? 'on' : ''}`}
                onClick={() => setCurrentTab(key)}
              >
                <SettingsTabIcon tab={key} />
                <span>{label}</span>
              </button>
            );
          })}
        </div>

        <div id="prefbody">
          {/* ================= APPEARANCE ================= */}
          {currentTab === 'appearance' && (
            <div className="scard">
              <div className="sr">
                <div>
                  <b>Accent Color</b>
                  <span className="sub">
                    {settings.accent === 'ocean'
                      ? 'Ocean'
                      : settings.accent === 'emerald'
                        ? 'Emerald'
                        : settings.accent === 'rose'
                          ? 'Rose'
                          : 'Indigo'}
                  </span>
                </div>
                <div className="sc">
                  <button
                    type="button"
                    className={`acs ${(!settings.accent || settings.accent === 'indigo') ? 'on' : ''}`}
                    style={{ background: 'linear-gradient(#7679ff, #4f46e5)' }}
                    title="Indigo"
                    onClick={() => update('accent', 'indigo')}
                  />
                  <button
                    type="button"
                    className={`acs ${settings.accent === 'ocean' ? 'on' : ''}`}
                    style={{ background: 'linear-gradient(#4fb3ff, #0a6fd8)' }}
                    title="Ocean"
                    onClick={() => update('accent', 'ocean')}
                  />
                  <button
                    type="button"
                    className={`acs ${settings.accent === 'emerald' ? 'on' : ''}`}
                    style={{ background: 'linear-gradient(#34d399, #059669)' }}
                    title="Emerald"
                    onClick={() => update('accent', 'emerald')}
                  />
                  <button
                    type="button"
                    className={`acs ${settings.accent === 'rose' ? 'on' : ''}`}
                    style={{ background: 'linear-gradient(#ff7ab0, #e11d63)' }}
                    title="Rose"
                    onClick={() => update('accent', 'rose')}
                  />
                </div>
              </div>

              <div className="sr">
                <div>
                  <b>Theme</b>
                  <span className="sub">Light, dark, or follow the system</span>
                </div>
                <div className="sc">
                  <select
                    className="sl"
                    value={settings.theme}
                    onChange={(e) => update('theme', e.target.value as AppSettings['theme'])}
                    style={{ width: 140 }}
                  >
                    <option value="light">Light</option>
                    <option value="dark">Dark</option>
                    <option value="system">System (auto)</option>
                  </select>
                </div>
              </div>

              <div className="sr">
                <div>
                  <b>Reduce Animations</b>
                  <span className="sub">Maximum smoothness on slower PCs</span>
                </div>
                <div className="sc">
                  <ToggleSwitch
                    checked={settings.motion}
                    onChange={(checked) => update('motion', checked)}
                    ariaLabel="Reduce Animations"
                  />
                </div>
              </div>
            </div>
          )}

          {/* ================= DOWNLOAD ENGINE ================= */}
          {currentTab === 'engine' && (
            <>
              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Default Download Folder</b>
                    <span className="sub">"{settings.dir}" will be used</span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      value={settings.dir}
                      onChange={(e) => update('dir', e.target.value)}
                      style={{ width: 270 }}
                    />
                    <button
                      className="btn"
                      style={{ minWidth: 0 }}
                      onClick={async () => {
                        try {
                          const selected = await open({
                            directory: true,
                            multiple: false,
                            defaultPath: settings.dir && settings.dir.trim() !== '' ? settings.dir : undefined,
                          });
                          if (selected && typeof selected === 'string') {
                            update('dir', selected);
                          }
                        } catch (err) {
                          console.error('Failed to select directory via native dialog:', err);
                        }
                      }}
                    >
                      Choose…
                    </button>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Use Category By Default</b>
                    <span className="sub">{settings.sort ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.sort}
                      onChange={(checked) => update('sort', checked)}
                      ariaLabel="Use Category By Default"
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Show Download Popup</b>
                    <span className="sub">
                      {settings.showDownloadPopup === 'never'
                        ? 'Never show progress window automatically'
                        : settings.showDownloadPopup === 'on_start'
                          ? 'Show progress window on start only'
                          : 'Always show download progress window'}
                    </span>
                  </div>
                  <div className="sc">
                    <select
                      className="sl"
                      value={settings.showDownloadPopup || 'always'}
                      onChange={(e) =>
                        update('showDownloadPopup', e.target.value as 'always' | 'on_start' | 'never')
                      }
                      style={{ width: 130 }}
                    >
                      <option value="always">Always</option>
                      <option value="on_start">On start only</option>
                      <option value="never">Never</option>
                    </select>
                  </div>
                </div>

                <div
                  className="sr"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const nextVal = settings.alwaysOnTop === false;
                    update('alwaysOnTop', nextVal);
                    flash(nextVal ? 'Progress Window Always on Top enabled' : 'Progress Window Always on Top disabled');
                  }}
                >
                  <div>
                    <b>Progress Window Always on Top</b>
                    <span className="sub">
                      {settings.alwaysOnTop !== false
                        ? 'Keep download progress windows above other windows'
                        : 'Allow download progress windows behind other windows'}
                    </span>
                  </div>
                  <div className="sc" onClick={(e) => e.stopPropagation()}>
                    <ToggleSwitch
                      id="setting-always-on-top"
                      checked={settings.alwaysOnTop !== false}
                      onChange={(checked) => {
                        update('alwaysOnTop', checked);
                        flash(checked ? 'Progress Window Always on Top enabled' : 'Progress Window Always on Top disabled');
                      }}
                      ariaLabel="Progress Window Always on Top"
                    />
                  </div>
                </div>

                <div
                  className="sr"
                  style={{ cursor: 'pointer' }}
                  onClick={() => {
                    const nextVal = settings.closeToTray === false;
                    update('closeToTray', nextVal);
                    flash(nextVal ? 'Close to System Tray enabled' : 'Close to System Tray disabled');
                  }}
                >
                  <div>
                    <b>Close to System Tray</b>
                    <span className="sub">
                      {settings.closeToTray !== false
                        ? 'Keep TORI running in the background when window is closed'
                        : 'Exit application when window is closed'}
                    </span>
                  </div>
                  <div className="sc" onClick={(e) => e.stopPropagation()}>
                    <ToggleSwitch
                      id="setting-close-to-tray"
                      checked={settings.closeToTray !== false}
                      onChange={(checked) => {
                        update('closeToTray', checked);
                        flash(checked ? 'Close to System Tray enabled' : 'Close to System Tray disabled');
                      }}
                      ariaLabel="Close to System Tray"
                    />
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Global Speed Limiter</b>
                    <span className="sub">
                      {settings.limMode === 'on' ? 'Limited' : 'Unlimited'}
                    </span>
                  </div>
                  <div className="sc">
                    <select
                      className="sl"
                      value={settings.limMode}
                      onChange={(e) => update('limMode', e.target.value as 'off' | 'on')}
                      style={{ width: 120 }}
                    >
                      <option value="off">Disabled</option>
                      <option value="on">Enabled</option>
                    </select>
                  </div>
                </div>

                <div className={`sr ${settings.limMode === 'off' ? 'dis' : ''}`} id="r-limv">
                  <div>
                    <b>Global Speed Limit</b>
                    <span className="sub">
                      {settings.limV.toFixed(2)} {settings.limU}
                    </span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      type="number"
                      min={1}
                      value={settings.limV}
                      onChange={(e) => update('limV', parseFloat(e.target.value) || 1)}
                      style={{ width: 84 }}
                      disabled={settings.limMode === 'off'}
                    />
                    <select
                      className="sl"
                      value={settings.limU}
                      onChange={(e) => update('limU', e.target.value as 'KiB/s' | 'MiB/s')}
                      style={{ width: 84 }}
                      disabled={settings.limMode === 'off'}
                    >
                      <option value="KiB/s">KiB/s</option>
                      <option value="MiB/s">MiB/s</option>
                    </select>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Thread Count</b>
                    <span className="sub">A download can have up to {settings.con} threads</span>
                  </div>
                  <div className="sc">
                    <input
                      id="scon"
                      className="in"
                      type="number"
                      min={1}
                      max={32}
                      value={settings.con}
                      onChange={(e) => update('con', parseInt(e.target.value, 10) || 16)}
                      style={{ width: 70 }}
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Maximum Concurrent Downloads</b>
                    <span className="sub">{settings.maxa} active jobs maximum</span>
                  </div>
                  <div className="sc">
                    <input
                      id="smaxa"
                      className="in"
                      type="number"
                      min={1}
                      max={20}
                      value={settings.maxa}
                      onChange={(e) => update('maxa', parseInt(e.target.value, 10) || 4)}
                      style={{ width: 70 }}
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Maximum Download Retries</b>
                    <span className="sub">
                      Failed downloads will be retried {settings.retries} time(s)
                    </span>
                  </div>
                  <div className="sc">
                    <input
                      id="sretries"
                      className="in"
                      type="number"
                      min={0}
                      max={20}
                      value={settings.retries}
                      onChange={(e) => update('retries', parseInt(e.target.value, 10) || 3)}
                      style={{ width: 70 }}
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Dynamic Part Creation</b>
                    <span className="sub">{settings.dyn ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.dyn}
                      onChange={(checked) => update('dyn', checked)}
                      ariaLabel="Dynamic Part Creation"
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Minimum Part Size</b>
                    <span className="sub">
                      {(settings.mps || 512).toFixed(2)} {settings.mpsU || 'KiB'}
                    </span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      type="number"
                      min={1}
                      value={settings.mps || 512}
                      onChange={(e) => update('mps', parseFloat(e.target.value) || 512)}
                      style={{ width: 84 }}
                    />
                    <select
                      className="sl"
                      value={settings.mpsU || 'KiB'}
                      onChange={(e) => update('mpsU', e.target.value as 'KiB' | 'MiB')}
                      style={{ width: 84 }}
                    >
                      <option value="KiB">KiB</option>
                      <option value="MiB">MiB</option>
                    </select>
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Per Host Settings</b>
                    <span className="sub">Custom speed & thread limits per domain</span>
                  </div>
                  <div className="sc">
                    <button className="btn" style={{ minWidth: 0 }} onClick={() => flash('Per host settings (configured)')}>
                      Change
                    </button>
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Use Proxy</b>
                    <span className="sub">{proxyLabel()}</span>
                  </div>
                  <div className="sc">
                    <button className="btn" style={{ minWidth: 0 }} onClick={handleCycleProxy}>
                      Change Proxy
                    </button>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>DNS</b>
                    <span className="sub">{settings.dns || 'System DNS'}</span>
                  </div>
                  <div className="sc">
                    <button className="btn" style={{ minWidth: 0 }} onClick={handleCycleDns}>
                      Change
                    </button>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Default User-Agent</b>
                    <span className="sub">{settings.ua ? 'Custom' : 'Default'}</span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      value={settings.ua}
                      onChange={(e) => update('ua', e.target.value)}
                      placeholder="Default"
                      style={{ width: 270 }}
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Ignore SSL Certificates</b>
                    <span className="sub">{settings.ssl ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.ssl}
                      onChange={(checked) => update('ssl', checked)}
                      ariaLabel="Ignore SSL Certificates"
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Use Server's Last-Modified Time</b>
                    <span className="sub">{settings.lm ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.lm}
                      onChange={(checked) => update('lm', checked)}
                      ariaLabel="Use Server's Last-Modified Time"
                    />
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Track Deleted Files On Disk</b>
                    <span className="sub">{settings.track ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.track}
                      onChange={(checked) => update('track', checked)}
                      ariaLabel="Track Deleted Files On Disk"
                    />
                  </div>
                </div>
              </div>
            </>
          )}

          {/* ================= BROWSER INTEGRATION ================= */}
          {currentTab === 'integration' && (
            <>
              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Enable Browser Integration</b>
                    <span className="sub">{settings.cap !== false ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <ToggleSwitch
                      checked={settings.cap !== false}
                      onChange={(checked) => update('cap', checked)}
                      ariaLabel="Enable Browser Integration"
                    />
                  </div>
                </div>

                <div className={`sr ${settings.cap === false ? 'dis' : ''}`} id="r-port">
                  <div>
                    <b>Server Port</b>
                    <span className="sub">Listening on 127.0.0.1:{settings.port || 6800}</span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      type="number"
                      min={1024}
                      max={65535}
                      value={settings.port || 6800}
                      onChange={(e) => update('port', parseInt(e.target.value, 10) || 6800)}
                      style={{ width: 90 }}
                      disabled={settings.cap === false}
                    />
                  </div>
                </div>

                <div className={`sr ${settings.cap === false ? 'dis' : ''}`} id="r-key">
                  <div>
                    <b>API Key</b>
                    <span className="sub">Paste this key into the browser extension to connect it</span>
                  </div>
                  <div className="sc">
                    <input
                      className="in"
                      id="keyin"
                      type={showApiKey ? 'text' : 'password'}
                      readOnly
                      value={settings.key || ''}
                      style={{ width: 210, fontFamily: 'ui-monospace, Menlo, Consolas, monospace', fontSize: 12 }}
                      disabled={settings.cap === false}
                    />
                    <button
                      className="btn"
                      style={{ minWidth: 0 }}
                      onClick={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? 'Hide' : 'Show'}
                    </button>
                    <button
                      className="btn"
                      style={{ minWidth: 0 }}
                      onClick={handleCopyKey}
                    >
                      Copy
                    </button>
                    <button
                      className="btn"
                      style={{ minWidth: 0 }}
                      onClick={handleRegenKey}
                    >
                      Regenerate
                    </button>
                  </div>
                </div>
              </div>

              <div className="scard">
                <div className="sr">
                  <div>
                    <b>Native Messaging Host</b>
                    <span className="sub">Registered for Chrome, Edge &amp; Firefox HKCU Registry</span>
                  </div>
                  <div className="sc">
                    <button type="button" className="btn" onClick={handleRegisterHost}>
                      Re-register Host
                    </button>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Chromium Extension ID</b>
                    <span className="sub" style={{ fontFamily: 'monospace' }}>
                      jfnfgmcbgapcpieaonbaolgebjaejcdm
                    </span>
                  </div>
                  <div className="sc">
                    <span className="green" style={{ fontWeight: 600 }}>Pinned</span>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Firefox Add-on ID</b>
                    <span className="sub" style={{ fontFamily: 'monospace' }}>
                      tori-download-manager@toridm.org
                    </span>
                  </div>
                  <div className="sc">
                    <span className="green" style={{ fontWeight: 600 }}>Pinned</span>
                  </div>
                </div>
              </div>

              {hostStatus && (
                <div style={{ textAlign: 'center', marginTop: 10, color: 'var(--blue)' }}>
                  {hostStatus}
                </div>
              )}
            </>
          )}

          {/* ================= EXTERNAL TOOLS ================= */}
          {currentTab === 'tools' && (
            <ExternalToolsPanel onFlash={flash} />
          )}

          {/* ================= ABOUT ================= */}
          {currentTab === 'about' && (
            <div style={{ textAlign: 'center', paddingTop: 18 }}>
              <ToriLogoIcon size={96} />

              <h2 style={{ margin: '14px 0 3px', fontSize: 21, color: 'var(--txt)', fontWeight: 600 }}>
                TORI Download Manager
              </h2>
              <div className="mut" style={{ fontSize: 13 }}>
                Version {appVersion}
              </div>
              <div style={{ fontSize: 12, color: 'var(--mut)', marginTop: 2 }}>
                Developed by TORI Download Manager Team
              </div>

              {/* Verified Project Links */}
              <div className="row" style={{ justifyContent: 'center', gap: 12, marginTop: 8, fontSize: 12, flexWrap: 'wrap' }}>
                <span
                  style={{ color: 'var(--blue)', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => openExternalUrl('https://github.com/robijoychakma375-hash/tori-download-manager')}
                >
                  GitHub Repository
                </span>
                <span style={{ color: 'var(--mut)' }}>•</span>
                <span
                  style={{ color: 'var(--blue)', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => openExternalUrl('https://github.com/robijoychakma375-hash/tori-download-manager/releases')}
                >
                  Releases & Downloads
                </span>
                <span style={{ color: 'var(--mut)' }}>•</span>
                <span
                  style={{ color: 'var(--blue)', cursor: 'pointer', textDecoration: 'underline' }}
                  onClick={() => openExternalUrl('https://github.com/robijoychakma375-hash/tori-download-manager/issues')}
                >
                  Issues & Feedback
                </span>
                {OFFICIAL_WEBSITE_URL && (
                  <>
                    <span style={{ color: 'var(--mut)' }}>•</span>
                    <span
                      style={{ color: 'var(--blue)', cursor: 'pointer', textDecoration: 'underline' }}
                      onClick={() => openExternalUrl(OFFICIAL_WEBSITE_URL)}
                    >
                      Official Website
                    </span>
                  </>
                )}
              </div>

              <p className="mut" style={{ margin: '12px 0 16px', lineHeight: '18px', fontSize: 12 }}>
                High-performance resumable multipart HTTP, RFC 8216 HLS, ISO/IEC 23009-1 MPEG-DASH,
                <br />
                BitTorrent P2P & Live Stream Recording with Chrome & Edge integration.
              </p>

              {/* Automatic Update Check Toggle */}
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                  gap: 10,
                  margin: '0 auto 16px',
                }}
              >
                <ToggleSwitch
                  checked={settings.autoCheckUpdates !== false}
                  onChange={(checked) => update('autoCheckUpdates', checked)}
                />
                <span style={{ fontSize: 12, color: 'var(--txt)' }}>Check for updates automatically (daily)</span>
              </div>

              {/* Action Buttons */}
              <div className="row" style={{ justifyContent: 'center', gap: 8, flexWrap: 'wrap' }}>
                <button
                  className="btn"
                  onClick={handleCheckForUpdates}
                  disabled={updateStatus.state === 'checking' || updateStatus.state === 'downloading'}
                >
                  {updateStatus.state === 'checking' ? 'Checking...' : 'Check for updates'}
                </button>
                <button className="btn" onClick={handleOpenDataFolder}>
                  Open data folder
                </button>
                <button className="btn" onClick={handleOpenLicenses}>
                  View Licenses
                </button>
                <button className="btn" onClick={() => setShowNotesModal(true)}>
                  Release Notes
                </button>
              </div>

              {/* Updater Status Display */}
              <div style={{ marginTop: 14, minHeight: 28 }}>
                {updateStatus.state === 'checking' && (
                  <p className="mut" style={{ fontSize: 12 }}>Checking update server for newer releases...</p>
                )}

                {updateStatus.state === 'up_to_date' && (
                  <p style={{ fontSize: 12, color: 'var(--green)', fontWeight: 500 }}>
                    ✓ You are running the latest verified production build (v{appVersion}).
                  </p>
                )}

                {updateStatus.state === 'available' && (
                  <div
                    style={{
                      background: 'var(--panel)',
                      border: '1px solid var(--blue)',
                      borderRadius: 8,
                      padding: 12,
                      margin: '12px auto 0',
                      maxWidth: 440,
                      textAlign: 'left',
                    }}
                  >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                      <b style={{ color: 'var(--txt)', fontSize: 13 }}>
                        Update Available: v{updateStatus.newVersion}
                      </b>
                      {updateStatus.releaseDate && (
                        <span className="mut" style={{ fontSize: 11 }}>
                          {new Date(updateStatus.releaseDate).toLocaleDateString()}
                        </span>
                      )}
                    </div>
                    {updateStatus.releaseNotes && (
                      <div
                        style={{
                          background: 'var(--win)',
                          border: '1px solid var(--pline)',
                          borderRadius: 4,
                          padding: 8,
                          margin: '8px 0',
                          maxHeight: 100,
                          overflowY: 'auto',
                          fontSize: 11,
                          lineHeight: '16px',
                          color: 'var(--txt)',
                          whiteSpace: 'pre-wrap',
                        }}
                      >
                        {updateStatus.releaseNotes}
                      </div>
                    )}
                    <div className="row" style={{ gap: 8, marginTop: 8 }}>
                      <button className="btn def" style={{ flex: 1 }} onClick={handleDownloadAndInstall}>
                        Download & Install
                      </button>
                      <button className="btn" onClick={handleRemindLater}>
                        Remind Me Later
                      </button>
                      <button
                        className="btn"
                        onClick={() =>
                          openExternalUrl('https://github.com/robijoychakma375-hash/tori-download-manager/releases')
                        }
                      >
                        GitHub
                      </button>
                    </div>
                  </div>
                )}

                {updateStatus.state === 'downloading' && (
                  <div style={{ maxWidth: 360, margin: '12px auto 0', textAlign: 'center' }}>
                    <div style={{ fontSize: 12, color: 'var(--txt)', marginBottom: 6 }}>
                      Downloading update: {(updateStatus.downloadedBytes / 1024 / 1024).toFixed(1)}
                      {updateStatus.totalBytes > 0
                        ? ` / ${(updateStatus.totalBytes / 1024 / 1024).toFixed(1)} MB`
                        : ' MB'}
                    </div>
                    <div
                      style={{
                        width: '100%',
                        height: 6,
                        background: 'var(--pline)',
                        borderRadius: 3,
                        overflow: 'hidden',
                      }}
                    >
                      <div
                        style={{
                          height: '100%',
                          background: 'var(--blue)',
                          width: `${updateStatus.totalBytes > 0 ? Math.min(100, (updateStatus.downloadedBytes / updateStatus.totalBytes) * 100) : 100}%`,
                        }}
                      />
                    </div>
                  </div>
                )}

                {updateStatus.state === 'ready' && (
                  <div
                    style={{
                      background: 'rgba(52, 211, 153, 0.12)',
                      border: '1px solid var(--green)',
                      borderRadius: 8,
                      padding: 12,
                      margin: '12px auto 0',
                      maxWidth: 400,
                    }}
                  >
                    <p style={{ color: 'var(--green)', fontSize: 13, fontWeight: 500, margin: '0 0 8px' }}>
                      ✓ Update downloaded and verified with signature!
                    </p>
                    <button className="btn def" onClick={handleDownloadAndInstall}>
                      Restart & Install Now
                    </button>
                  </div>
                )}

                {updateStatus.state === 'blocked_active_downloads' && (
                  <div
                    style={{
                      background: 'rgba(239, 68, 68, 0.1)',
                      border: '1px solid var(--bad)',
                      borderRadius: 8,
                      padding: 12,
                      margin: '12px auto 0',
                      maxWidth: 420,
                      textAlign: 'left',
                    }}
                  >
                    <b style={{ color: 'var(--bad)', fontSize: 13 }}>
                      ⚠️ Active Downloads In Progress
                    </b>
                    <p style={{ fontSize: 12, color: 'var(--txt)', margin: '6px 0 10px' }}>
                      Cannot restart while {updateStatus.activeDownloadsCount} download(s) are actively downloading.
                      Please pause or complete them before updating to prevent transfer interruption.
                    </p>
                    <div className="row" style={{ gap: 8 }}>
                      <button className="btn" onClick={handleDownloadAndInstall}>
                        Retry Installation
                      </button>
                      <button className="btn" onClick={() => setUpdateStatus((prev) => ({ ...prev, state: 'idle' }))}>
                        Dismiss
                      </button>
                    </div>
                  </div>
                )}

                {updateStatus.state === 'error' && (
                  <div style={{ maxWidth: 420, margin: '12px auto 0' }}>
                    <p style={{ fontSize: 12, color: 'var(--bad)', margin: '0 0 6px' }}>
                      {updateStatus.errorMessage}
                    </p>
                    <button className="btn" style={{ fontSize: 11 }} onClick={handleCheckForUpdates}>
                      Try Again
                    </button>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Third-Party Notices Modal */}
        {showLicensesModal && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 200,
            }}
          >
            <div
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--pline)',
                borderRadius: 8,
                width: '85%',
                maxWidth: 620,
                maxHeight: '80%',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                padding: 16,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <b style={{ color: 'var(--txt)', fontSize: 14 }}>Open-Source & Third-Party Licenses</b>
                <button className="btn" onClick={() => setShowLicensesModal(false)} style={{ minWidth: 0, padding: '0 8px' }}>
                  ✕
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  background: 'var(--win)',
                  border: '1px solid var(--pline)',
                  borderRadius: 4,
                  padding: 12,
                  fontFamily: 'monospace',
                  fontSize: 11,
                  lineHeight: '16px',
                  color: 'var(--txt)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {licensesContent || 'Loading third-party license notices...'}
              </div>
              <div style={{ textAlign: 'right', marginTop: 12 }}>
                <button className="btn def" onClick={() => setShowLicensesModal(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Release Notes Modal */}
        {showNotesModal && (
          <div
            style={{
              position: 'absolute',
              inset: 0,
              background: 'rgba(0,0,0,0.65)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              zIndex: 200,
            }}
          >
            <div
              style={{
                background: 'var(--panel)',
                border: '1px solid var(--pline)',
                borderRadius: 8,
                width: '85%',
                maxWidth: 620,
                maxHeight: '80%',
                display: 'flex',
                flexDirection: 'column',
                boxShadow: '0 8px 32px rgba(0,0,0,0.4)',
                padding: 16,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
                <b style={{ color: 'var(--txt)', fontSize: 14 }}>TORI Download Manager — Release Notes v{appVersion}</b>
                <button className="btn" onClick={() => setShowNotesModal(false)} style={{ minWidth: 0, padding: '0 8px' }}>
                  ✕
                </button>
              </div>
              <div
                style={{
                  flex: 1,
                  overflowY: 'auto',
                  background: 'var(--win)',
                  border: '1px solid var(--pline)',
                  borderRadius: 4,
                  padding: 12,
                  fontSize: 12,
                  lineHeight: '18px',
                  color: 'var(--txt)',
                  whiteSpace: 'pre-wrap',
                }}
              >
                {`TORI Download Manager v${appVersion} (External Tools Security Hardening & Stage 1 Key-Separation Readiness)
• Versioned, purpose-bound External Tools TrustedToolsKeyring supporting safe Stage 1 dual-key transition, key revocation, and wrong-purpose rejection
• Consumer-safe Signed Manifest verification status, current revision, expiration, and next scheduled check inside Settings → External Tools
• Independent External Tools Auto-Update Manager for yt-dlp (OpenPGP RSA-4096), FFmpeg & FFprobe (TORI Ed25519 signed manifests) with atomic activation, active-use deferral, automatic/manual rollback, and bundled fallback
• Hardened anti-replay, equivocation detection, duplicate JSON key rejection, and unauthorized trust-escalation rejection
• Standalone IDM-style Download Progress Window with Pause/Resume, completion options, and compact mode
• Instant NTFS sparse file allocation (FSCTL_SET_SPARSE), multi-connection HTTP ranges, HLS/DASH remuxing, and BitTorrent/magnet support
• Browser Companion v1.0.10 compatibility across Chrome, Edge, and Firefox with Close-to-Tray lifecycle and signed Desktop Auto-Updater`}
              </div>
              <div style={{ textAlign: 'right', marginTop: 12 }}>
                <button className="btn def" onClick={() => setShowNotesModal(false)}>
                  Close
                </button>
              </div>
            </div>
          </div>
        )}

        {toast && (
          <div
            style={{
              position: 'absolute',
              bottom: 60,
              left: '50%',
              transform: 'translateX(-50%)',
              background: 'rgba(0,0,0,0.8)',
              color: '#fff',
              padding: '6px 14px',
              borderRadius: 6,
              fontSize: 12,
              zIndex: 100,
            }}
          >
            {toast}
          </div>
        )}

        <div className="foot">
          <button className="btn def" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
};
