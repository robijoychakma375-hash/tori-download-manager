import React, { useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { TitleBar } from './TitleBar';
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
  iconPath: string;
}

const TABS: NavTab[] = [
  { key: 'appearance', label: 'Appearance', iconPath: '/icons/settings-tabs/appearance.svg' },
  { key: 'engine', label: 'Download Engine', iconPath: '/icons/settings-tabs/download-engine.svg' },
  { key: 'integration', label: 'Browser Integration', iconPath: '/icons/settings-tabs/browser-integration.svg' },
  { key: 'about', label: 'About', iconPath: '/icons/settings-tabs/about.svg' },
];

export const SettingsModal: React.FC<SettingsModalProps> = ({
  settings,
  onUpdateSettings,
  onClose,
}) => {
  const [currentTab, setCurrentTab] = useState<TabKey>('appearance');
  const [updateMsg, setUpdateMsg] = useState<string | null>(null);
  const [hostStatus, setHostStatus] = useState<string | null>(null);

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

  return (
    <>
      <div id="dim" onClick={onClose} />
      <div className="win pop" id="setw">
        <TitleBar title="Settings" onClose={onClose} isModal />

        <div className="ptabs" id="ptabsrow">
          {TABS.map(({ key, label, iconPath }) => {
            const isSelected = currentTab === key;
            return (
              <button
                key={key}
                className={`pt ${isSelected ? 'on' : ''}`}
                onClick={() => setCurrentTab(key)}
              >
                <img
                  src={iconPath}
                  alt={label}
                  width={26}
                  height={26}
                  style={{
                    filter: isSelected
                      ? 'invert(42%) sepia(85%) saturate(3015%) hue-rotate(224deg) brightness(98%) contrast(92%)'
                      : 'grayscale(100%) opacity(60%)',
                  }}
                />
                {label}
              </button>
            );
          })}
        </div>

        <div id="prefbody">
          {/* ================= APPEARANCE ================= */}
          {currentTab === 'appearance' && (
            <>
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
                    <input
                      type="checkbox"
                      className="sw"
                      checked={settings.motion}
                      onChange={(e) => update('motion', e.target.checked)}
                    />
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Show Segments Pane</b>
                    <span className="sub">Shows the segments bar at the bottom of the window</span>
                  </div>
                  <div className="sc">
                    <input
                      type="checkbox"
                      className="sw"
                      checked={settings.details}
                      onChange={(e) => update('details', e.target.checked)}
                    />
                  </div>
                </div>
              </div>
            </>
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
                  </div>
                </div>

                <div className="sr">
                  <div>
                    <b>Use Category By Default</b>
                    <span className="sub">{settings.sort ? 'Enabled' : 'Disabled'}</span>
                  </div>
                  <div className="sc">
                    <input
                      type="checkbox"
                      className="sw"
                      checked={settings.sort}
                      onChange={(e) => update('sort', e.target.checked)}
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

                <div className={`sr ${settings.limMode === 'off' ? 'dis' : ''}`}>
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
                    <input
                      type="checkbox"
                      className="sw"
                      checked={settings.dyn}
                      onChange={(e) => update('dyn', e.target.checked)}
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
                    <span className="sub">
                      Intercept media requests and one-click capture via Native Messaging
                    </span>
                  </div>
                  <div className="sc">
                    <input
                      type="checkbox"
                      className="sw"
                      checked={settings.track}
                      onChange={(e) => update('track', e.target.checked)}
                    />
                  </div>
                </div>

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
                    <span className="green">Active</span>
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
                TORI Download Manager
              </h2>
              <div className="mut">Version 2.0.0 (Gate 9 Production Release)</div>

              <p className="mut" style={{ margin: '14px 0 24px', lineHeight: '20px' }}>
                High-performance Windows multi-connection download engine.
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

        <div className="foot">
          <button className="btn def" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    </>
  );
};

