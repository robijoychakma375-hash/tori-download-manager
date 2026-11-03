import React from 'react';

interface ToggleSwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  id?: string;
  ariaLabel?: string;
}

export const ToggleSwitch: React.FC<ToggleSwitchProps> = ({
  checked,
  onChange,
  disabled = false,
  id,
  ariaLabel,
}) => {
  return (
    <label className={`swl ${disabled ? 'dis' : ''}`} htmlFor={id}>
      <input
        id={id}
        type="checkbox"
        className="swi"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
        aria-label={ariaLabel}
      />
      <span className="sw-track">
        <span className="sw-knob" />
      </span>
    </label>
  );
};

