import React from 'react';
import type { CategoryKey, DownloadJob } from '../types';
import { typeOfJob, getChipSrc } from '../utils';

interface SideBarProps {
  currentCategory: CategoryKey;
  onSelectCategory: (cat: CategoryKey) => void;
  downloads: DownloadJob[];
}

interface NavItem {
  key: CategoryKey;
  label: string;
}

const LIBRARY_ITEMS: NavItem[] = [
  { key: 'all', label: 'All Downloads' },
  { key: 'unf', label: 'Unfinished' },
  { key: 'fin', label: 'Finished' },
];

const CATEGORY_ITEMS: NavItem[] = [
  { key: 'Video', label: 'Video' },
  { key: 'Music', label: 'Music' },
  { key: 'Compressed', label: 'Compressed' },
  { key: 'Programs', label: 'Programs' },
  { key: 'Documents', label: 'Documents' },
];

export const SideBar: React.FC<SideBarProps> = ({
  currentCategory,
  onSelectCategory,
  downloads,
}) => {
  const getCount = (cat: CategoryKey): number => {
    switch (cat) {
      case 'all':
        return downloads.length;
      case 'unf':
        return downloads.filter((d) => d.state !== 'completed').length;
      case 'fin':
        return downloads.filter((d) => d.state === 'completed').length;
      default:
        return downloads.filter((d) => typeOfJob(d) === cat).length;
    }
  };

  return (
    <div id="side">
      <h6>Library</h6>
      {LIBRARY_ITEMS.map(({ key, label }) => {
        const isSelected = currentCategory === key;
        return (
          <div
            key={key}
            className={`si ${isSelected ? 'on' : ''}`}
            onClick={() => onSelectCategory(key)}
          >
            <span className="sn">
              <img
                src={getChipSrc(key)}
                alt={label}
                width={19}
                height={19}
                style={{ borderRadius: '5.5px' }}
              />
              {label}
            </span>
            <em>{getCount(key)}</em>
          </div>
        );
      })}

      <h6>Categories</h6>
      {CATEGORY_ITEMS.map(({ key, label }) => {
        const isSelected = currentCategory === key;
        return (
          <div
            key={key}
            className={`si ${isSelected ? 'on' : ''}`}
            onClick={() => onSelectCategory(key)}
          >
            <span className="sn">
              <img
                src={getChipSrc(key)}
                alt={label}
                width={19}
                height={19}
                style={{ borderRadius: '5.5px' }}
              />
              {label}
            </span>
            <em>{getCount(key)}</em>
          </div>
        );
      })}
    </div>
  );
};

