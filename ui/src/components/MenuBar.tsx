import React, { useEffect, useRef, useState } from 'react';
import type { AppSettings, CategoryKey, SortField } from '../types';

export type MenuKey = 'tasks' | 'file' | 'downloads' | 'view' | 'help';

interface MenuItemSpec {
  label: string;
  shortcut?: string;
  disabled?: boolean;
  checked?: boolean;
  danger?: boolean;
  onClick: () => void;
}

type MenuEntry = MenuItemSpec | { divider: true };

interface MenuBarProps {
  selectedCount: number;
  singleSelectedComplete: boolean;
  hasSingleSelection: boolean;
  canResume: boolean;
  canPause: boolean;
  hasActiveDownloads: boolean;
  hasCompletedDownloads: boolean;
  currentCategory: CategoryKey;
  sortField: SortField | null;
  currentTheme: AppSettings['theme'];
  isModalOpen?: boolean;
  onAdd: () => void;
  onResumeSelected: () => void;
  onPauseSelected: () => void;
  onStopAll: () => void;
  onStartQueue: () => void;
  onOpenFile: () => void;
  onOpenFolder: () => void;
  onOpenProgress: () => void;
  onCopyUrl: () => void;
  onRetrySelected: () => void;
  onVerifyChecksum: () => void;
  onDeleteSelected: () => void;
  onClearCompleted: () => void;
  onSelectAll: () => void;
  onClearSelection: () => void;
  onSelectCategory: (cat: CategoryKey) => void;
  onSortBy: (field: SortField | null) => void;
  onChangeTheme: (theme: AppSettings['theme']) => void;
  onOpenSettings: (tab?: 'appearance' | 'engine' | 'integration' | 'about') => void;
  onOpenDataFolder: () => void;
  onExit: () => void;
}

export const MenuBar: React.FC<MenuBarProps> = ({
  selectedCount,
  singleSelectedComplete,
  hasSingleSelection,
  canResume,
  canPause,
  hasActiveDownloads,
  hasCompletedDownloads,
  currentCategory,
  sortField,
  currentTheme,
  isModalOpen = false,
  onAdd,
  onResumeSelected,
  onPauseSelected,
  onStopAll,
  onStartQueue,
  onOpenFile,
  onOpenFolder,
  onOpenProgress,
  onCopyUrl,
  onRetrySelected,
  onVerifyChecksum,
  onDeleteSelected,
  onClearCompleted,
  onSelectAll,
  onClearSelection,
  onSelectCategory,
  onSortBy,
  onChangeTheme,
  onOpenSettings,
  onOpenDataFolder,
  onExit,
}) => {
  const [openMenu, setOpenMenu] = useState<MenuKey | null>(null);
  const [prevModalOpen, setPrevModalOpen] = useState(isModalOpen);
  const barRef = useRef<HTMLDivElement>(null);

  if (isModalOpen !== prevModalOpen) {
    setPrevModalOpen(isModalOpen);
    if (isModalOpen && openMenu !== null) {
      setOpenMenu(null);
    }
  }

  useEffect(() => {
    if (!openMenu) return;

    const handleDocClick = (e: Event) => {
      if (barRef.current && !barRef.current.contains(e.target as Node)) {
        setOpenMenu(null);
      }
    };
    const handleKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpenMenu(null);
      }
    };
    document.addEventListener('mousedown', handleDocClick);
    document.addEventListener('click', handleDocClick);
    document.addEventListener('focusin', handleDocClick);
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('mousedown', handleDocClick);
      document.removeEventListener('click', handleDocClick);
      document.removeEventListener('focusin', handleDocClick);
      document.removeEventListener('keydown', handleKey);
    };
  }, [openMenu]);

  const menus: Record<MenuKey, { label: string; items: MenuEntry[] }> = {
    tasks: {
      label: 'Tasks',
      items: [
        { label: 'Add new download…', shortcut: 'Ctrl+N', onClick: onAdd },
        { divider: true },
        {
          label: selectedCount > 1 ? `Resume selected (${selectedCount})` : 'Resume',
          disabled: selectedCount === 0 || !canResume,
          onClick: onResumeSelected,
        },
        {
          label: selectedCount > 1 ? `Pause selected (${selectedCount})` : 'Pause',
          disabled: selectedCount === 0 || !canPause,
          onClick: onPauseSelected,
        },
        {
          label: 'Stop all downloads',
          disabled: !hasActiveDownloads,
          onClick: onStopAll,
        },
        { divider: true },
        { label: 'Exit TORI', onClick: onExit },
      ],
    },
    file: {
      label: 'File',
      items: [
        {
          label: 'Open file',
          disabled: !singleSelectedComplete,
          onClick: onOpenFile,
        },
        {
          label: 'Open folder',
          disabled: !hasSingleSelection,
          onClick: onOpenFolder,
        },
        {
          label: 'Show progress window',
          disabled: !hasSingleSelection,
          onClick: onOpenProgress,
        },
        {
          label: 'Copy download URL',
          disabled: !hasSingleSelection,
          onClick: onCopyUrl,
        },
        { divider: true },
        {
          label: 'Redownload',
          disabled: !hasSingleSelection,
          onClick: onRetrySelected,
        },
        {
          label: 'Verify SHA-256 checksum',
          disabled: !singleSelectedComplete,
          onClick: onVerifyChecksum,
        },
        { divider: true },
        {
          label: selectedCount > 1 ? `Delete (${selectedCount} items)` : 'Delete',
          shortcut: 'Del',
          disabled: selectedCount === 0,
          danger: true,
          onClick: onDeleteSelected,
        },
        {
          label: 'Remove all completed',
          disabled: !hasCompletedDownloads,
          onClick: onClearCompleted,
        },
      ],
    },
    downloads: {
      label: 'Downloads',
      items: [
        { label: 'Start queue', onClick: onStartQueue },
        { label: 'Pause all', disabled: !hasActiveDownloads, onClick: onStopAll },
        { divider: true },
        { label: 'Select all', shortcut: 'Ctrl+A', onClick: onSelectAll },
        {
          label: 'Clear selection',
          disabled: selectedCount === 0,
          onClick: onClearSelection,
        },
        { divider: true },
        {
          label: 'Options / Settings…',
          shortcut: 'Ctrl+,',
          onClick: () => onOpenSettings('engine'),
        },
      ],
    },
    view: {
      label: 'View',
      items: [
        {
          label: 'All Downloads',
          checked: currentCategory === 'all',
          onClick: () => onSelectCategory('all'),
        },
        {
          label: 'Unfinished',
          checked: currentCategory === 'unf',
          onClick: () => onSelectCategory('unf'),
        },
        {
          label: 'Finished',
          checked: currentCategory === 'fin',
          onClick: () => onSelectCategory('fin'),
        },
        { divider: true },
        {
          label: 'Default order',
          checked: sortField === null,
          onClick: () => onSortBy(null),
        },
        {
          label: 'Sort by File name',
          checked: sortField === 'filename',
          onClick: () => onSortBy('filename'),
        },
        {
          label: 'Sort by Size',
          checked: sortField === 'size',
          onClick: () => onSortBy('size'),
        },
        {
          label: 'Sort by Status',
          checked: sortField === 'status',
          onClick: () => onSortBy('status'),
        },
        {
          label: 'Sort by Last try date',
          checked: sortField === 'date',
          onClick: () => onSortBy('date'),
        },
        { divider: true },
        {
          label: 'Light theme',
          checked: currentTheme === 'light',
          onClick: () => onChangeTheme('light'),
        },
        {
          label: 'Dark theme',
          checked: currentTheme === 'dark',
          onClick: () => onChangeTheme('dark'),
        },
        {
          label: 'System theme',
          checked: currentTheme === 'system',
          onClick: () => onChangeTheme('system'),
        },
      ],
    },
    help: {
      label: 'Help',
      items: [
        {
          label: 'Check for updates…',
          onClick: () => onOpenSettings('about'),
        },
        {
          label: 'Browser integration setup…',
          onClick: () => onOpenSettings('integration'),
        },
        {
          label: 'Open data folder',
          onClick: onOpenDataFolder,
        },
        { divider: true },
        {
          label: 'About TORI Download Manager…',
          onClick: () => onOpenSettings('about'),
        },
      ],
    },
  };

  const menuOrder: MenuKey[] = ['tasks', 'file', 'downloads', 'view', 'help'];

  return (
    <div className="menubar" ref={barRef} role="menubar" aria-label="Main Menu">
      {menuOrder.map((key) => {
        const spec = menus[key];
        const isOpen = openMenu === key;
        return (
          <div key={key} className="mb-wrap">
            <button
              type="button"
              className={`mbi ${isOpen ? 'on' : ''}`}
              role="menuitem"
              aria-haspopup="menu"
              aria-expanded={isOpen}
              onClick={() => setOpenMenu((prev) => (prev === key ? null : key))}
              onMouseEnter={() => {
                if (openMenu && openMenu !== key) {
                  setOpenMenu(key);
                }
              }}
            >
              {spec.label}
            </button>

            {isOpen && (
              <div className="mbm" role="menu">
                {spec.items.map((item, idx) =>
                  'divider' in item ? (
                    <hr key={`div-${idx}`} />
                  ) : (
                    <button
                      key={item.label}
                      type="button"
                      className={`mbm-item ${item.danger ? 'danger' : ''}`}
                      disabled={item.disabled}
                      role="menuitem"
                      onClick={() => {
                        setOpenMenu(null);
                        item.onClick();
                      }}
                    >
                      <span className="mbm-chk">{item.checked ? '✓' : ''}</span>
                      <span className="mbm-lbl">{item.label}</span>
                      {item.shortcut && <span className="mbm-key">{item.shortcut}</span>}
                    </button>
                  )
                )}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
};
export default MenuBar;
