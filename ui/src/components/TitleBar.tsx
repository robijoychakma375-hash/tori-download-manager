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
  const handleClose = async () => {
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

  const handleMinimize = async () => {
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

  const handleMaximize = async () => {
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
      <span className="dot d1" onClick={handleClose} title="Close" />
      <span className="dot d2" onClick={handleMinimize} title="Minimize" />
      {!isModal && <span className="dot d3" onClick={handleMaximize} title="Maximize" />}
      {title}
      {isModal && (
        <button className="xb" onClick={handleClose} title="Close">
          ×
        </button>
      )}
    </div>
  );
};

