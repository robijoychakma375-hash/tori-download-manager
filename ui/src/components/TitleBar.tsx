import React from 'react';
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
    if (onMaximize) {
      onMaximize();
    } else {
      try {
        await invoke('window_maximize');
      } catch (err) {
        console.error('Failed to maximize window:', err);
      }
    }
  };

  return (
    <div className="wbar" data-tauri-drag-region>
      {title}
      {isModal ? (
        <button className="xb" onClick={handleClose} title="Close">
          ×
        </button>
      ) : (
        <span className="wc">
          <b onClick={handleMinimize} title="Minimize">
            <svg viewBox="0 0 10 10">
              <path d="M0 5h10" />
            </svg>
          </b>
          <b onClick={handleMaximize} title="Maximize">
            <svg viewBox="0 0 10 10">
              <rect x="0.5" y="0.5" width="9" height="9" rx="1" />
            </svg>
          </b>
          <b onClick={handleClose} title="Close">
            <svg viewBox="0 0 10 10">
              <path d="M0 0l10 10M10 0L0 10" />
            </svg>
          </b>
        </span>
      )}
    </div>
  );
};
export default TitleBar;
