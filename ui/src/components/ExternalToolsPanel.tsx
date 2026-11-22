import React, { useEffect, useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { ToggleSwitch } from './ToggleSwitch';
import type {
  ExternalToolHistoryEntry,
  ExternalToolId,
  ExternalToolProgressEvent,
  ExternalToolRecord,
  ExternalToolsSettings,
  ExternalToolsSnapshot,
  ExternalToolUpdateStatus,
} from '../types';

interface ExternalToolsPanelProps {
  onFlash: (msg: string) => void;
}

const DEFAULT_TOOLS_SETTINGS: ExternalToolsSettings = {
  auto_update: true,
  check_interval_hours: 24,
  auto_install: true,
  notify_on_update: true,
  defer_while_in_use: true,
};

const STATUS_META: Record<
  ExternalToolUpdateStatus,
  { label: string; tone: 'ok' | 'info' | 'warn' | 'bad' | 'muted' }
> = {
  up_to_date: { label: 'Up to Date', tone: 'ok' },
  checking: { label: 'Checking...', tone: 'info' },
  update_available: { label: 'Update Available', tone: 'info' },
  downloading: { label: 'Downloading...', tone: 'info' },
  verifying: { label: 'Verifying...', tone: 'info' },
  testing: { label: 'Testing...', tone: 'info' },
  pending_activation: { label: 'Pending Activation', tone: 'warn' },
  installing: { label: 'Installing...', tone: 'info' },
  updated: { label: 'Updated', tone: 'ok' },
  update_failed: { label: 'Update Failed', tone: 'bad' },
  rolled_back: { label: 'Rolled Back', tone: 'warn' },
  source_untrusted: { label: 'Source Untrusted', tone: 'warn' },
};

function formatBytesCompact(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function formatSpeedCompact(bps: number): string {
  if (!Number.isFinite(bps) || bps <= 0) return '';
  return `${formatBytesCompact(bps)}/s`;
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return 'Never';
  try {
    const dt = new Date(iso);
    if (Number.isNaN(dt.getTime())) return iso;
    return dt.toLocaleString();
  } catch {
    return iso;
  }
}

export const ExternalToolsPanel: React.FC<ExternalToolsPanelProps> = ({ onFlash }) => {
  const [snapshot, setSnapshot] = useState<ExternalToolsSnapshot | null>(null);
  const [loading, setLoading] = useState<boolean>(true);
  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [progress, setProgress] = useState<ExternalToolProgressEvent | null>(null);
  const [showHistoryModal, setShowHistoryModal] = useState<boolean>(false);
  const [history, setHistory] = useState<ExternalToolHistoryEntry[]>([]);
  const [historyLoading, setHistoryLoading] = useState<boolean>(false);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);

  const loadStatus = useCallback(async () => {
    try {
      const data = await invoke<ExternalToolsSnapshot>('get_external_tools_status');
      setSnapshot(data);
      setErrorBanner(null);
    } catch (err) {
      setErrorBanner(`Failed loading external tools status: ${String(err)}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    let active = true;
    const refresh = () => {
      invoke<ExternalToolsSnapshot>('get_external_tools_status')
        .then((data) => {
          if (!active) return;
          setSnapshot(data);
          setErrorBanner(null);
          const inFlight = data.tools.some((t) =>
            ['downloading', 'verifying', 'testing', 'installing'].includes(t.update_status)
          );
          if (!inFlight) {
            setProgress(null);
          }
        })
        .catch((err) => {
          if (!active) return;
          setErrorBanner(`Failed loading external tools status: ${String(err)}`);
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    };

    refresh();

    const unlistenPromises = [
      listen('external-tools-status-changed', () => {
        refresh();
      }),
      listen<ExternalToolProgressEvent>('external-tools-progress', (event) => {
        const payload = event.payload;
        if (!payload || !active) return;
        setProgress(payload);
        if (
          payload.status === 'updated' ||
          payload.status === 'up_to_date' ||
          payload.status === 'update_failed' ||
          payload.status === 'rolled_back' ||
          payload.status === 'pending_activation'
        ) {
          setTimeout(() => {
            if (active) setProgress(null);
          }, 1200);
        }
      }),
    ];

    return () => {
      active = false;
      unlistenPromises.forEach((p) => {
        p.then((unlisten) => unlisten()).catch(() => {});
      });
    };
  }, []);

  const settings = snapshot?.settings ?? DEFAULT_TOOLS_SETTINGS;
  const tools: ExternalToolRecord[] = snapshot?.tools ?? [];
  const manifestStatus = snapshot?.manifest_status;

  const manifestTone: 'ok' | 'info' | 'warn' | 'bad' | 'muted' =
    manifestStatus?.verification_status === 'verified'
      ? 'ok'
      : manifestStatus?.verification_status === 'rejected_security'
        ? 'bad'
        : manifestStatus?.verification_status === 'network_unavailable' ||
            manifestStatus?.verification_status === 'unpublished'
          ? 'warn'
          : 'muted';

  const manifestStatusLabel =
    manifestStatus?.verification_status === 'verified'
      ? manifestStatus.current_revision
        ? `Manifest Verified · Rev ${manifestStatus.current_revision}`
        : 'Manifest Verified'
      : manifestStatus?.verification_status === 'rejected_security'
        ? 'Manifest Blocked (Security)'
        : manifestStatus?.verification_status === 'network_unavailable'
          ? 'Manifest Unreachable'
          : manifestStatus?.verification_status === 'unpublished'
            ? 'Direct Verification Mode'
            : 'Manifest Pending Check';

  const updatePolicy = async (patch: Partial<ExternalToolsSettings>) => {
    const next: ExternalToolsSettings = { ...settings, ...patch };
    try {
      const saved = await invoke<ExternalToolsSettings>('save_external_tool_update_settings', {
        settings: next,
      });
      setSnapshot((prev) => (prev ? { ...prev, settings: saved } : prev));
      onFlash('External tool update policy saved');
    } catch (err) {
      setErrorBanner(`Failed saving external tool settings: ${String(err)}`);
    }
  };

  const handleCheckUpdates = async () => {
    setBusyAction('check');
    setErrorBanner(null);
    try {
      const next = await invoke<ExternalToolsSnapshot>('check_external_tools_updates');
      setSnapshot(next);
      onFlash('External tool update check completed');
    } catch (err) {
      setErrorBanner(`Update check failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleUpdateAll = async () => {
    setBusyAction('update_all');
    setErrorBanner(null);
    try {
      const next = await invoke<ExternalToolsSnapshot>('update_all_external_tools');
      setSnapshot(next);
      setProgress(null);
      onFlash('External tools update completed');
    } catch (err) {
      setErrorBanner(`External tool update failed: ${String(err)}`);
    } finally {
      setBusyAction(null);
    }
  };

  const handleUpdateSingle = async (toolId: ExternalToolId) => {
    setBusyAction(`update:${toolId}`);
    setErrorBanner(null);
    try {
      const next = await invoke<ExternalToolsSnapshot>('update_external_tool', { toolId });
      setSnapshot(next);
      setProgress(null);
      onFlash(`${toolId} update finished`);
    } catch (err) {
      setErrorBanner(String(err));
      await loadStatus();
    } finally {
      setBusyAction(null);
    }
  };

  const handleRollback = async (toolId: ExternalToolId) => {
    setBusyAction(`rollback:${toolId}`);
    setErrorBanner(null);
    try {
      const next = await invoke<ExternalToolsSnapshot>('rollback_external_tool', { toolId });
      setSnapshot(next);
      onFlash(`${toolId} rolled back to previous verified version`);
    } catch (err) {
      setErrorBanner(String(err));
      await loadStatus();
    } finally {
      setBusyAction(null);
    }
  };

  const handleOpenLocation = async (toolId: ExternalToolId) => {
    try {
      const loc = await invoke<string>('open_external_tool_location', { toolId });
      onFlash(`Opened ${loc}`);
    } catch (err) {
      setErrorBanner(`Failed opening tool location: ${String(err)}`);
    }
  };

  const handleOpenHistory = async () => {
    setShowHistoryModal(true);
    setHistoryLoading(true);
    try {
      const entries = await invoke<ExternalToolHistoryEntry[]>('get_external_tool_update_history', {
        limit: 100,
      });
      setHistory(entries);
    } catch (err) {
      setErrorBanner(`Failed loading update history: ${String(err)}`);
    } finally {
      setHistoryLoading(false);
    }
  };

  const hasTrustedUpdateAvailable = tools.some(
    (t) =>
      t.update_status === 'update_available' ||
      t.update_status === 'pending_activation'
  );
  const failedTools = tools.filter((t) => t.update_status === 'update_failed');
  const untrustedTool = tools.find((t) => t.update_status === 'source_untrusted');
  const activeOperation =
    busyAction !== null ||
    Boolean(snapshot?.checking) ||
    tools.some((t) =>
      ['checking', 'downloading', 'verifying', 'testing', 'installing'].includes(t.update_status)
    );

  const progressPct =
    progress && progress.total_bytes && progress.total_bytes > 0
      ? Math.min(100, Math.round((progress.downloaded_bytes / progress.total_bytes) * 100))
      : null;

  return (
    <div data-testid="external-tools-panel">
      {/* Header & Status Card */}
      <div className="scard" style={{ paddingBottom: 14 }}>
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            gap: 12,
            padding: '12px 0 8px',
          }}
        >
          <div>
            <h3
              id="ext-tools-heading"
              style={{ margin: 0, fontSize: 13.5, fontWeight: 600, color: 'var(--txt)' }}
            >
              External Tools Update Manager
            </h3>
            <span className="sub" style={{ display: 'block', marginTop: 2, fontSize: 11.5, color: 'var(--mut)' }}>
              Independently update yt-dlp, FFmpeg, and FFprobe with cryptographic verification &amp; automatic rollback
            </span>
          </div>
          <div style={{ fontSize: 11, color: 'var(--mut)', textAlign: 'right', flex: 'none' }}>
            <div>Last check: {formatTimestamp(snapshot?.scheduler.last_successful_check_at ?? null)}</div>
            {manifestStatus?.next_scheduled_check_at && (
              <div style={{ marginTop: 2 }} data-testid="external-tools-next-check">
                Next check: {formatTimestamp(manifestStatus.next_scheduled_check_at)}
              </div>
            )}
            {snapshot && (snapshot.active_yt_dlp_leases > 0 || snapshot.active_ffmpeg_leases > 0 || snapshot.active_ffprobe_leases > 0) && (
              <div style={{ color: 'var(--a3)', fontWeight: 600, marginTop: 2 }}>
                Tools active in use (updates deferred safely)
              </div>
            )}
          </div>
        </div>

        {/* Consumer-Safe Signed Manifest & Trust Verification Summary (Phase 15) */}
        {manifestStatus && (
          <div className="et-trust-strip" data-testid="external-tools-manifest-status">
            <div className="et-trust-row">
              <span
                className={`et-badge et-tone-${manifestTone}`}
                data-testid="manifest-verification-badge"
              >
                {manifestStatusLabel}
              </span>
              <span className="et-trust-source" title={manifestStatus.trusted_source_status}>
                {manifestStatus.trusted_source_status}
              </span>
            </div>
            <div className="et-trust-meta">
              <span data-testid="manifest-last-verified">
                Last manifest verify: {formatTimestamp(manifestStatus.last_verified_at)}
              </span>
              {manifestStatus.current_revision !== null && (
                <span data-testid="manifest-revision-meta">
                  Revision: {manifestStatus.current_revision}
                </span>
              )}
              {manifestStatus.expires_at && (
                <span data-testid="manifest-expires-meta">
                  Valid until: {formatTimestamp(manifestStatus.expires_at)}
                </span>
              )}
            </div>
            {manifestStatus.last_failure && (
              <div className="et-trust-failure" data-testid="manifest-last-failure">
                Last failure: {manifestStatus.last_failure}
              </div>
            )}
          </div>
        )}

        {/* Accessible Scrollable Semantic Status Table */}
        <div
          className="et-table-region"
          tabIndex={0}
          role="region"
          aria-labelledby="ext-tools-heading"
        >
          <table className="et-table" data-testid="external-tools-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: '13%' }}>Tool</th>
                <th scope="col" style={{ width: '21%' }}>Installed Version</th>
                <th scope="col" style={{ width: '19%' }}>Latest Version</th>
                <th scope="col" style={{ width: '19%' }}>Status</th>
                <th scope="col" style={{ width: '28%', textAlign: 'right' }}>Actions</th>
              </tr>
            </thead>
            <tbody>
              {loading && tools.length === 0 ? (
                <tr>
                  <td colSpan={5} style={{ textAlign: 'center', color: 'var(--mut)', padding: '14px 8px' }}>
                    Probing installed external tools...
                  </td>
                </tr>
              ) : (
                tools.map((tool) => {
                  const meta = STATUS_META[tool.update_status] || STATUS_META.up_to_date;
                  const canUpdateRow =
                    !activeOperation &&
                    (tool.update_status === 'update_available' ||
                      tool.update_status === 'pending_activation' ||
                      tool.update_status === 'update_failed');
                  const canRollbackRow = !activeOperation && tool.rollback_available;
                  return (
                    <tr key={tool.tool_id} data-tool-row={tool.tool_id}>
                      <td>
                        <div className="et-cell-ellipsis" title={`${tool.display_name} (${tool.source})`}>
                          <strong style={{ fontWeight: 600 }}>{tool.display_name}</strong>
                        </div>
                        <div className="et-sub-tag">{tool.source}</div>
                      </td>
                      <td>
                        <div
                          className="et-cell-ellipsis et-mono"
                          title={tool.installed_version || 'Not detected'}
                          data-tool-installed={tool.tool_id}
                        >
                          {tool.installed_version || 'Not detected'}
                        </div>
                      </td>
                      <td>
                        <div
                          className="et-cell-ellipsis et-mono"
                          title={tool.available_version || tool.installed_version || 'Not checked'}
                          data-tool-latest={tool.tool_id}
                        >
                          {tool.available_version || '—'}
                        </div>
                      </td>
                      <td>
                        <span
                          className={`et-badge et-tone-${meta.tone}`}
                          title={tool.last_error || meta.label}
                          data-tool-status={tool.tool_id}
                        >
                          {meta.label}
                        </span>
                      </td>
                      <td>
                        <div className="et-row-actions">
                          {canUpdateRow && (
                            <button
                              type="button"
                              className="btn et-mini-btn def"
                              data-action={`update-${tool.tool_id}`}
                              onClick={() => handleUpdateSingle(tool.tool_id)}
                              title={`Update ${tool.display_name}`}
                            >
                              {tool.update_status === 'pending_activation' ? 'Activate' : 'Update'}
                            </button>
                          )}
                          <button
                            type="button"
                            className="btn et-mini-btn"
                            data-action={`rollback-${tool.tool_id}`}
                            disabled={!canRollbackRow}
                            onClick={() => handleRollback(tool.tool_id)}
                            title={
                              tool.rollback_available
                                ? `Roll back to ${tool.rollback_version || 'previous version'}`
                                : 'No rollback version stored'
                            }
                          >
                            Roll Back
                          </button>
                          <button
                            type="button"
                            className="btn et-mini-btn"
                            data-action={`locate-${tool.tool_id}`}
                            disabled={!tool.active_binary_path}
                            onClick={() => handleOpenLocation(tool.tool_id)}
                            title={tool.active_binary_path || 'Tool location unavailable'}
                          >
                            Location
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>

        {/* Live Progress Strip (only shown during real download/verification/test/install) */}
        {progress && (
          <div className="et-progress-card" data-testid="external-tools-progress">
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 11.5, marginBottom: 5 }}>
              <span style={{ fontWeight: 600, color: 'var(--txt)' }}>
                {progress.tool_id}: {progress.stage}
              </span>
              <span className="et-mono" style={{ color: 'var(--mut)' }}>
                {formatBytesCompact(progress.downloaded_bytes)}
                {progress.total_bytes ? ` / ${formatBytesCompact(progress.total_bytes)}` : ''}
                {progress.speed_bps > 0 ? ` • ${formatSpeedCompact(progress.speed_bps)}` : ''}
              </span>
            </div>
            <div className="et-progress-track">
              <div
                className="et-progress-fill"
                style={{ width: `${progressPct !== null ? progressPct : 100}%` }}
              />
            </div>
          </div>
        )}

        {/* Untrusted Source Disclosure */}
        {untrustedTool && (
          <div className="et-notice et-notice-warn" data-testid="external-tools-untrusted-notice">
            <b>Cryptographic Verification Policy ({untrustedTool.display_name}):</b>{' '}
            {untrustedTool.last_error ||
              'Upstream FFmpeg builds currently lack a publisher cryptographic signature. Automatic installation is blocked until verified by a TORI Ed25519-signed tools manifest.'}
          </div>
        )}

        {/* Error Notice */}
        {errorBanner && (
          <div className="et-notice et-notice-bad" data-testid="external-tools-error-notice">
            {errorBanner}
          </div>
        )}

        {/* Primary Action Buttons */}
        <div className="et-actions-bar">
          <button
            type="button"
            className="btn"
            data-testid="btn-check-tools-updates"
            disabled={activeOperation}
            onClick={handleCheckUpdates}
          >
            {busyAction === 'check' || snapshot?.checking ? 'Checking...' : 'Check for Updates'}
          </button>

          <button
            type="button"
            className={`btn ${hasTrustedUpdateAvailable ? 'def' : ''}`}
            data-testid="btn-update-tools-now"
            disabled={activeOperation || !hasTrustedUpdateAvailable}
            onClick={handleUpdateAll}
          >
            {busyAction === 'update_all' ? 'Updating...' : 'Update Now'}
          </button>

          {failedTools.length > 0 && (
            <button
              type="button"
              className="btn"
              data-testid="btn-retry-failed-tools"
              disabled={activeOperation}
              onClick={() => handleUpdateSingle(failedTools[0].tool_id)}
            >
              Retry Failed Update
            </button>
          )}

          <button
            type="button"
            className="btn"
            data-testid="btn-view-tools-history"
            onClick={handleOpenHistory}
          >
            View Update History
          </button>

          <button
            type="button"
            className="btn"
            data-testid="btn-open-tool-location"
            disabled={!tools.some((t) => Boolean(t.active_binary_path))}
            onClick={() => {
              const first = tools.find((t) => Boolean(t.active_binary_path));
              if (first) handleOpenLocation(first.tool_id);
            }}
          >
            Open Tool Location
          </button>
        </div>
      </div>

      {/* Policy Settings Card */}
      <div className="scard">
        <div className="sr">
          <div>
            <b>Automatically update external tools</b>
            <span className="sub">
              {settings.auto_update
                ? 'Enabled — keep yt-dlp, FFmpeg, and FFprobe current without waiting for a TORI release'
                : 'Disabled — external tools will only update when you click Check for Updates / Update Now'}
            </span>
          </div>
          <div className="sc">
            <ToggleSwitch
              id="ext-tools-auto-update"
              checked={settings.auto_update}
              onChange={(checked) => updatePolicy({ auto_update: checked })}
              ariaLabel="Automatically update external tools"
            />
          </div>
        </div>

        <div className="sr">
          <div>
            <b>Check for updates</b>
            <span className="sub">
              {settings.check_interval_hours === 0
                ? 'Manual only — background checks disabled'
                : settings.check_interval_hours === 168
                  ? 'Check automatically every 7 days in the background'
                  : 'Check automatically every 24 hours and on startup if due'}
            </span>
          </div>
          <div className="sc">
            <select
              className="sl"
              data-testid="select-tools-interval"
              value={String(settings.check_interval_hours)}
              onChange={(e) =>
                updatePolicy({ check_interval_hours: parseInt(e.target.value, 10) || 0 })
              }
              style={{ width: 155 }}
            >
              <option value="24">Every 24 hours</option>
              <option value="168">Every 7 days</option>
              <option value="0">Manual only</option>
            </select>
          </div>
        </div>

        <div className={`sr ${!settings.auto_update ? 'dis' : ''}`}>
          <div>
            <b>Automatically install verified updates</b>
            <span className="sub">
              Install automatically after SHA-256 checksum, cryptographic signature, and health checks pass
            </span>
          </div>
          <div className="sc">
            <ToggleSwitch
              id="ext-tools-auto-install"
              checked={settings.auto_install}
              onChange={(checked) => updatePolicy({ auto_install: checked })}
              ariaLabel="Automatically install verified updates"
            />
          </div>
        </div>

        <div className="sr">
          <div>
            <b>Notify when updated</b>
            <span className="sub">
              Show desktop alerts when tools update, postpone while busy, fail, or roll back
            </span>
          </div>
          <div className="sc">
            <ToggleSwitch
              id="ext-tools-notify"
              checked={settings.notify_on_update}
              onChange={(checked) => updatePolicy({ notify_on_update: checked })}
              ariaLabel="Notify when updated"
            />
          </div>
        </div>

        <div className="sr">
          <div>
            <b>Defer updates while tools are in use</b>
            <span className="sub">
              Protect active media downloads, HLS/DASH muxing, and live recordings; activate once idle
            </span>
          </div>
          <div className="sc">
            <ToggleSwitch
              id="ext-tools-defer-in-use"
              checked={settings.defer_while_in_use}
              onChange={(checked) => updatePolicy({ defer_while_in_use: checked })}
              ariaLabel="Defer updates while tools are in use"
            />
          </div>
        </div>
      </div>

      {/* Update History Modal */}
      {showHistoryModal && (
        <div
          className="et-modal-backdrop"
          data-testid="external-tools-history-modal"
          onClick={() => setShowHistoryModal(false)}
        >
          <div className="et-modal-box" onClick={(e) => e.stopPropagation()}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <b style={{ fontSize: 14, color: 'var(--txt)' }}>External Tools Update History</b>
              <button
                type="button"
                className="btn"
                style={{ minWidth: 0, padding: '0 8px' }}
                onClick={() => setShowHistoryModal(false)}
              >
                ✕
              </button>
            </div>

            <div className="et-history-scroll" tabIndex={0} role="region" aria-label="External Tools Update History">
              {historyLoading ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--mut)' }}>
                  Loading update history...
                </div>
              ) : history.length === 0 ? (
                <div style={{ padding: 16, textAlign: 'center', color: 'var(--mut)' }}>
                  No external tool update events recorded yet.
                </div>
              ) : (
                <table className="et-table et-history-table">
                  <thead>
                    <tr>
                      <th scope="col" style={{ width: '22%' }}>Timestamp</th>
                      <th scope="col" style={{ width: '13%' }}>Tool</th>
                      <th scope="col" style={{ width: '14%' }}>Action</th>
                      <th scope="col" style={{ width: '19%' }}>Version</th>
                      <th scope="col" style={{ width: '32%' }}>Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {history.map((entry) => (
                      <tr key={entry.id}>
                        <td className="et-mono" style={{ fontSize: 11 }}>
                          <div className="et-cell-ellipsis" title={entry.created_at}>
                            {formatTimestamp(entry.created_at)}
                          </div>
                        </td>
                        <td>
                          <strong style={{ fontWeight: 600 }}>{entry.tool_id}</strong>
                        </td>
                        <td>
                          <span className="et-sub-tag">
                            {entry.action.replace(/_/g, ' ')} ({entry.status.replace(/_/g, ' ')})
                          </span>
                        </td>
                        <td className="et-mono" style={{ fontSize: 11 }}>
                          <div
                            className="et-cell-ellipsis"
                            title={`${entry.from_version || '—'} → ${entry.to_version || '—'}`}
                          >
                            {entry.from_version ? `${entry.from_version} → ` : ''}
                            {entry.to_version || '—'}
                          </div>
                        </td>
                        <td>
                          <div className="et-cell-ellipsis" title={entry.message || ''}>
                            {entry.message || '—'}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>

            <div style={{ textAlign: 'right', marginTop: 12 }}>
              <button type="button" className="btn def" onClick={() => setShowHistoryModal(false)}>
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
