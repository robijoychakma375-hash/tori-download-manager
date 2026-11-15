import React from 'react';
import { fmtSp } from '../utils';

interface StatusBarProps {
  activeCount: number;
  totalSpeedBps: number;
  visibleCount: number;
  totalCount: number;
  isExtensionConnected: boolean;
  statusMessage?: string | null;
}

export const StatusBar: React.FC<StatusBarProps> = React.memo(
  ({
    activeCount,
    totalSpeedBps,
    visibleCount,
    totalCount,
    isExtensionConnected,
    statusMessage,
  }) => {
    const countLabel =
      visibleCount === totalCount
        ? `${totalCount} items`
        : `${visibleCount} of ${totalCount} items`;

    return (
      <footer id="stat">
        <span>{statusMessage || `${activeCount} active`}</span>
        <span>Speed {totalSpeedBps > 0 ? fmtSp(totalSpeedBps) : '0 KB/s'}</span>
        <span>{countLabel}</span>
        <span className="stat-conn">
          <i className={`gd ${isExtensionConnected ? '' : 'off'}`} />
          <span>{isExtensionConnected ? 'Extension connected' : 'Native Host ready'}</span>
        </span>
      </footer>
    );
  }
);
StatusBar.displayName = 'StatusBar';
