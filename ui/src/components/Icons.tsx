import React from 'react';

export type ChipCategory =
  | 'all'
  | 'unf'
  | 'fin'
  | 'Video'
  | 'Music'
  | 'Compressed'
  | 'Programs'
  | 'Documents'
  | 'Other'
  | string;

interface ChipStyle {
  gradient: string;
  paths: string[];
}

const CHIP_STYLES: Record<string, ChipStyle> = {
  all: {
    gradient: 'linear-gradient(#6366f1, #4345a4)',
    paths: ['M12 4v10M8 10l4 4 4-4M5 19h14'],
  },
  unf: {
    gradient: 'linear-gradient(#ff9f0a, #ad6c07)',
    paths: ['M12 7v5l3 2M12 4a8 8 0 100 16 8 8 0 000-16z'],
  },
  fin: {
    gradient: 'linear-gradient(#30c75e, #218740)',
    paths: ['M5 12l5 5 9-10'],
  },
  Video: {
    gradient: 'linear-gradient(#ff453a, #ad2f27)',
    paths: ['M9 6.5v11l9-5.5z'],
  },
  Music: {
    gradient: 'linear-gradient(#ff375f, #ad2541)',
    paths: ['M9 18V6l10-2v12M7 20a2 2 0 100-4 2 2 0 000 4zM17 18a2 2 0 100-4 2 2 0 000 4z'],
  },
  Compressed: {
    gradient: 'linear-gradient(#bf5af2, #823da5)',
    paths: ['M12 3v10M10 6h4M10 9h4M8 13h8v6H8z'],
  },
  Programs: {
    gradient: 'linear-gradient(#0a84ff, #075aad)',
    paths: ['M8 8l-4 4 4 4M16 8l4 4-4 4'],
  },
  Documents: {
    gradient: 'linear-gradient(#32ade6, #22769c)',
    paths: ['M7 3h7l5 5v13H7zM14 3v5h5M10 13h6M10 17h6'],
  },
  Other: {
    gradient: 'linear-gradient(#8e8e93, #616164)',
    paths: ['M7 3h7l5 5v13H7z'],
  },
};

export const CategoryChip: React.FC<{ category: ChipCategory; size?: number }> = React.memo(
  ({ category, size = 19 }) => {
    const spec = CHIP_STYLES[category] || CHIP_STYLES.Other;
    const radius = size >= 24 ? 6 : 5.5;
    return (
      <i
        className="ft"
        aria-hidden="true"
        style={{
          background: spec.gradient,
          width: size,
          height: size,
          borderRadius: radius,
        }}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
          {spec.paths.map((d, idx) => (
            <path key={idx} d={d} />
          ))}
        </svg>
      </i>
    );
  }
);
CategoryChip.displayName = 'CategoryChip';

export type ToolbarIconKind = 'add' | 'resume' | 'pause' | 'stopall' | 'del' | 'queue' | 'settings';

export const ToolbarIcon: React.FC<{ kind: ToolbarIconKind }> = React.memo(({ kind }) => {
  switch (kind) {
    case 'add':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="var(--a3, #6366f1)" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="9" />
          <path d="M12 8v8M8 12h8" />
        </svg>
      );
    case 'resume':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#22b45a" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M8 5l11 7-11 7z" />
        </svg>
      );
    case 'pause':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M9 5v14M15 5v14" />
        </svg>
      );
    case 'stopall':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#ff5d73" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <rect x="6" y="6" width="12" height="12" rx="2" />
        </svg>
      );
    case 'del':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#8e8e93" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M5 7h14M10 7V5h4v2M7 7l1 12h8l1-12" />
        </svg>
      );
    case 'queue':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#3b82f6" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M4 7h10M4 12h10M4 17h6M17 11l4 3-4 3z" />
        </svg>
      );
    case 'settings':
      return (
        <svg viewBox="0 0 24 24" fill="none" stroke="#8e8e93" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="3" />
          <path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" />
        </svg>
      );
  }
});
ToolbarIcon.displayName = 'ToolbarIcon';

export const SettingsTabIcon: React.FC<{ tab: 'appearance' | 'engine' | 'integration' | 'tools' | 'about' }> = React.memo(
  ({ tab }) => {
    switch (tab) {
      case 'appearance':
        return (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 3v18" />
            <path d="M12 3a9 9 0 0 1 0 18z" fill="currentColor" />
          </svg>
        );
      case 'engine':
        return (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M13 3L5 14h6l-1 7 8-11h-6z" />
          </svg>
        );
      case 'integration':
        return (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M10 14a4 4 0 005.7 0l3-3a4 4 0 00-5.7-5.7l-1 1M14 10a4 4 0 00-5.7 0l-3 3a4 4 0 005.7 5.7l1-1" />
          </svg>
        );
      case 'tools':
        return (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14.7 6.3a4 4 0 00-5.4 5.4l-5 5a1.5 1.5 0 002.1 2.1l5-5a4 4 0 005.4-5.4l-2.3 2.3-2.1-2.1 2.3-2.3z" />
            <path d="M17 14v6M14 17l3 3 3-3" />
          </svg>
        );
      case 'about':
        return (
          <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
            <circle cx="12" cy="12" r="9" />
            <path d="M12 11v6M12 7.5v.01" />
          </svg>
        );
    }
  }
);
SettingsTabIcon.displayName = 'SettingsTabIcon';

export const ToriLogoIcon: React.FC<{ size?: number }> = React.memo(({ size = 96 }) => (
  <svg width={size} height={size} viewBox="0 0 1024 1024" style={{ display: 'block', margin: '0 auto' }}>
    <defs>
      <linearGradient id="tori-about-logo-grad" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="var(--a1, #696cf6)" />
        <stop offset="1" stopColor="var(--a2, #3e34be)" />
      </linearGradient>
    </defs>
    <rect width="1024" height="1024" rx="232" fill="url(#tori-about-logo-grad)" />
    <g fill="none" stroke="#fff" strokeWidth="100" strokeLinecap="round" strokeLinejoin="round">
      <path d="M176 199C344 281 680 281 848 199" strokeWidth="96" />
      <path d="M512 285V649" />
      <path d="M340 569L512 741L684 569" />
      <path d="M330 847H694" strokeWidth="52" />
    </g>
  </svg>
));
ToriLogoIcon.displayName = 'ToriLogoIcon';
