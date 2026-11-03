import React from 'react';
import type { DownloadJob } from '../types';
import { fmtSp } from '../utils';

interface StatusBarProps {
  downloads: DownloadJob[];
  isExtensionConnected: boolean;
  statusMessage?: string | null;
}

export const StatusBar: React.FC<StatusBarProps> = ({
  downloads,
  isExtensionConnected,
  statusMessage,
}) => {
  const activeDownloads = downloads.filter(
    (d) => d.state === 'downloading' || d.state === 'probing'
  );
  const totalSpeedBps = activeDownloads.reduce((sum, d) => sum + (d.speed_bps || 0), 0);

  return (
    <div id="stat">
      <span>
        {statusMessage ? statusMessage : `${activeDownloads.length} active`}
      </span>
      <span>
        Speed {totalSpeedBps > 0 ? fmtSp(totalSpeedBps) : '0 KB/sec'}
      </span>
      <span style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center' }}>
        <i className={`gd ${isExtensionConnected ? '' : 'off'}`} />
        <span>
          {isExtensionConnected ? 'Extension connected' : 'Native Host ready'}
        </span>
      </span>
    </div>
  );
};

