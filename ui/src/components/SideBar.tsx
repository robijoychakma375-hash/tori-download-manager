import React, { useMemo } from 'react';
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
  const counts = useMemo(() => {
    let unf = 0;
    let fin = 0;
    let video = 0;
    let music = 0;
    let compressed = 0;
    let programs = 0;
    let documents = 0;

    for (let i = 0; i < downloads.length; i++) {
      const d = downloads[i];
      if (d.state === 'completed') {
        fin++;
      } else {
        unf++;
      }
      const cat = typeOfJob(d);
      if (cat === 'Video') video++;
      else if (cat === 'Music') music++;
      else if (cat === 'Compressed') compressed++;
      else if (cat === 'Programs') programs++;
      else if (cat === 'Documents') documents++;
    }

    return {
      all: downloads.length,
      unf,
      fin,
      Video: video,
      Music: music,
      Compressed: compressed,
      Programs: programs,
      Documents: documents,
    };
  }, [downloads]);

  const getCount = (cat: CategoryKey): number => {
    return counts[cat] ?? 0;
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

