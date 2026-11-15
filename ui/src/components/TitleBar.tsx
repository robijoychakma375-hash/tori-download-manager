import React, { useEffect, useState } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';

interface TitleBarProps {
  title?: string;
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isModal?: boolean;
}

export const TitleBar: React.FC<TitleBarProps> = ({
  title = 'Tori Download Manager',
  onClose,
  onMinimize,
  onMaximize,
  isModal = false,
}) => {
  const [isMaximized, setIsMaximized] = useState(false);

  useEffect(() => {
    if (isModal) return;
    let unlisten: (() => void) | undefined;
    let active = true;

    const syncMaximized = async () => {
      try {
        const win = getCurrentWindow();
        const max = await win.isMaximized();
        if (active) setIsMaximized(max);
      } catch {
        // Non-Tauri browser preview environment
      }
    };

    syncMaximized();

    try {
      const win = getCurrentWindow();
      win
        .onResized(() => {
          syncMaximized();
        })
        .then((fn) => {
          if (active) unlisten = fn;
          else fn();
        })
        .catch(() => {});
    } catch {
      // Ignore if running outside Tauri
    }

    return () => {
      active = false;
      if (unlisten) {
        try {
          unlisten();
        } catch {
          // ignore
        }
      }
    };
  }, [isModal]);

  const toggleMaximizeWindow = async () => {
    if (onMaximize) {
      onMaximize();
      return;
    }
    try {
      await invoke('window_maximize');
    } catch {
      try {
        const win = getCurrentWindow();
        await win.toggleMaximize();
      } catch {
        // ignore
      }
    }
    try {
      const win = getCurrentWindow();
      setIsMaximized(await win.isMaximized());
    } catch {
      // ignore
    }
  };

  const handleMouseDown = async (e: React.MouseEvent) => {
    if (e.button !== 0) return;

    const target = e.target as HTMLElement;
    if (target.closest('.wc') || target.closest('.xb') || target.closest('button')) {
      return;
    }

    if (e.detail === 2) {
      if (!isModal) {
        await toggleMaximizeWindow();
      }
      return;
    }

    try {
      const win = getCurrentWindow();
      await win.startDragging();
    } catch {
      // Ignore if not in Tauri
    }
  };

  const handleClose = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onClose) {
      onClose();
    } else {
      try {
        await invoke('window_close');
      } catch (err) {
        console.error('Failed to close window:', err);
      }
    }
  };

  const handleMinimize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (onMinimize) {
      onMinimize();
    } else {
      try {
        await invoke('window_minimize');
      } catch (err) {
        console.error('Failed to minimize window:', err);
      }
    }
  };

  const handleMaximize = async (e: React.MouseEvent) => {
    e.stopPropagation();
    await toggleMaximizeWindow();
  };

  return (
    <div
      className="wbar"
      data-tauri-drag-region
      onMouseDown={handleMouseDown}
    >
      <span className="wtitle">{title}</span>
      {isModal ? (
        <button type="button" className="xb" onClick={handleClose} title="Close" aria-label="Close">
          ×
        </button>
      ) : (
        <span className="wc">
          <b onClick={handleMinimize} title="Minimize" role="button" aria-label="Minimize">
            <svg viewBox="0 0 10 10">
              <path d="M0 5h10" />
            </svg>
          </b>
          <b
            onClick={handleMaximize}
            title={isMaximized ? 'Restore' : 'Maximize'}
            role="button"
            aria-label={isMaximized ? 'Restore' : 'Maximize'}
          >
            {isMaximized ? (
              <svg viewBox="0 0 10 10">
                <path d="M2.5 2.5V0.8h6.7v6.7H7.5" />
                <rect x="0.8" y="2.5" width="6.7" height="6.7" rx="0.8" />
              </svg>
            ) : (
              <svg viewBox="0 0 10 10">
                <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
              </svg>
            )}
          </b>
          <b onClick={handleClose} title="Close" role="button" aria-label="Close">
            <svg viewBox="0 0 10 10">
              <path d="M1 1l8 8M9 1L1 9" />
            </svg>
          </b>
        </span>
      )}
    </div>
  );
};

export default TitleBar;
