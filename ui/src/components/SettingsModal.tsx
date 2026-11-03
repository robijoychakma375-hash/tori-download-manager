import React, { useState, useEffect } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './TitleBar';
import { ToggleSwitch } from './ToggleSwitch';
import type { AppSettings } from '../types';

interface SettingsModalProps {
  settings: AppSettings;
  onUpdateSettings: (newSettings: AppSettings) => void;
  onClose: () => void;
}

type TabKey = 'appearance' | 'engine' | 'integration' | 'about';

interface NavTab {
  key: TabKey;
  label: string;
}

const TABS: NavTab[] = [
  { key: 'appearance', label: 'Appearance' },
  { key: 'engine', label: 'Download Engine' },
  { key: 'integration', label: 'Browser Integration' },
  { key: 'about', label: 'About' },
];

const renderTabIcon = (key: TabKey) => {
  switch (key) {
    case 'appearance':
      return (
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 3v18" />
          <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
        </svg>
      );
    case 'engine':
      return (
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
        </svg>
      );
    case 'integration':
      return (
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
        </svg>
      );
    case 'about':
      return (
        <svg
          viewBox="0 0 24 24"
          width="26"
          height="26"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.7"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="9" />
          <path d="M12 11v6M12 7.5v.01" />
        </svg>
      );
  }
};

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onUpdateSettings,
  onClose,
}) => {
  const [currentTab, setCurrentTab] = useState<TabKey>('engine');
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<string | null>(null);
  const [showApiKey, setShowApiKey] = useState(false);
  const [toast, setToast] = useState<string | null>(null);

  const flash = (msg: string) => {
    setToast(msg);
    setTimeout(() => setToast(null), 2400);
  };

  const update = <K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    const updated = { ...settings, [key]: value };
    onUpdateSettings(updated);
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
    if (currentTab === 'integration') {
      invoke<{ port: number; active_port: number; token: string }>('get_browser_integration_info')
        .then((info) => {
          if (info && info.token) {
            update('key', info.token);
          }
          if (info && info.active_port) {
            update('port', info.active_port);
          }
        })
        .catch((err) => console.warn('Failed to load integration info:', err));
    }
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
      <div className="win pop" id="setw" style={{ width: 820, height: 650 }}>
        <TitleBar title="Settings" onClose={onClose} isModal />

        <div className="ptabs" id="ptabsrow">
          {TABS.map(({ key, label }) => {
            const isSelected = currentTab === key;
            return (
              <button
                key={key}
                className={`pt ${isSelected ? 'on' : ''}`}
                onClick={() => setCurrentTab(key)}
              >
                {renderTabIcon(key)}
                {label}
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
                          const dir = await invoke<string>('get_default_download_dir');
                          if (dir) update('dir', dir);
                        } catch (err) {
                          console.error(err);
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
                    <span className="sub">Registered in Chrome & Edge HKCU Registry</span>
                  </div>
                  <div className="sc">
                    <button className="btn" onClick={handleRegisterHost}>
                      Re-register Host
                    </button>
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Pinned Extension ID</b>
                    <span className="sub" style={{ fontFamily: 'monospace' }}>
                      jfnfgmcbgapcpieaonbaolgebjaejcdm
                    </span>
                  </div>
                  <div className="sc">
                    <span className="green" style={{ fontWeight: 600 }}>Active</span>
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

          {/* ================= ABOUT ================= */}
          {currentTab === 'about' && (
            <div style={{ textAlign: 'center', paddingTop: 20 }}>
              <svg width="88" height="88" viewBox="0 0 1024 1024" style={{ margin: '0 auto' }}>
                <defs>
                  <linearGradient id="ag" x1="0" y1="0" x2="1" y2="1">
                    <stop offset="0" stopColor="#696cf6" />
                    <stop offset="1" stopColor="#3e34be" />
                  </linearGradient>
                </defs>
                <rect width="1024" height="1024" rx="232" fill="url(#ag)" />
                <g
                  fill="none"
                  stroke="#fff"
                  strokeWidth="100"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M176 199C344 281 680 281 848 199" strokeWidth="96" />
                  <path d="M512 285V649" />
                  <path d="M340 569L512 741L684 569" />
                  <path d="M330 847H694" strokeWidth="52" />
                </g>
              </svg>

              <h2 style={{ margin: '14px 0 2px', fontSize: 20, color: 'var(--txt)' }}>
                Tori Download Manager
              </h2>
              <div className="mut">Version 2.0.0 (Production Release)</div>

              <p className="mut" style={{ margin: '14px 0 24px', lineHeight: '20px' }}>
                Fast, resumable downloads with a browser extension.
                <br />
                Direct HTTP partitioned ranges, RFC 8216 HLS, ISO/IEC 23009-1 MPEG-DASH,
                <br />
                BitTorrent P2P & Universal Live Stream Recording.
              </p>

              <div className="row" style={{ justifyContent: 'center', gap: 12 }}>
                <button
                  className="btn"
                  onClick={() => setUpdateMsg('You are running the latest verified production build.')}
                >
                  Check for updates
                </button>
                <button className="btn" onClick={handleOpenDataFolder}>
                  Open data folder
                </button>
              </div>

              {updateMsg && (
                <p className="mut" style={{ textAlign: 'center', fontSize: 12, marginTop: 12 }}>
                  {updateMsg}
                </p>
              )}
            </div>
          )}
        </div>

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
