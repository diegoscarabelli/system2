/**
 * MultiSelectDropdown Component
 *
 * Custom dropdown with checkboxes for multiselect filtering.
 * Supports an "All" toggle that checks/unchecks all options.
 * Closes on click outside or Escape.
 */

import { ChevronDownIcon } from '@primer/octicons-react';
import { Box, Text } from '@primer/react';
import { useEffect, useRef, useState } from 'react';

export interface MultiSelectOption {
  value: string;
  label: string;
}

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
}: {
  label: string;
  options: MultiSelectOption[];
  selected: Set<string>;
  onChange: (selected: Set<string>) => void;
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  const allSelected = options.length > 0 && options.every((o) => selected.has(o.value));

  // Close on click outside
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open]);

  const toggleAll = () => {
    if (allSelected) {
      onChange(new Set());
    } else {
      onChange(new Set(options.map((o) => o.value)));
    }
  };

  const toggleOption = (value: string) => {
    const base = new Set(selected);
    if (base.has(value)) base.delete(value);
    else base.add(value);
    onChange(base);
  };

  const capitalizedLabel = label.charAt(0).toUpperCase() + label.slice(1);
  const displayLabel = allSelected
    ? `All ${label}`
    : selected.size === 0
      ? capitalizedLabel
      : selected.size === 1
        ? (options.find((o) => selected.has(o.value))?.label ?? capitalizedLabel)
        : `${selected.size} ${label}`;

  return (
    <Box ref={ref} sx={{ position: 'relative' }}>
      <Box
        as="button"
        onClick={() => setOpen(!open)}
        sx={{
          background: 'transparent',
          border: '1px solid',
          borderColor: 'border.default',
          borderRadius: 2,
          padding: '4px 8px',
          fontSize: '13px',
          color: 'fg.default',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          whiteSpace: 'nowrap',
          '&:hover': { borderColor: 'fg.muted' },
        }}
      >
        <Text sx={{ fontSize: '13px' }}>{displayLabel}</Text>
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            color: 'fg.muted',
            transform: open ? 'rotate(180deg)' : 'none',
            transition: 'transform 0.15s',
          }}
        >
          <ChevronDownIcon size={12} />
        </Box>
      </Box>

      {open && (
        <Box
          sx={{
            position: 'absolute',
            top: 'calc(100% + 4px)',
            left: 0,
            zIndex: 100,
            minWidth: '100%',
            maxHeight: 250,
            overflowY: 'auto',
            backgroundColor: 'canvas.default',
            border: '1px solid',
            borderColor: 'border.default',
            borderRadius: 2,
            py: 1,
            boxShadow: '0 4px 12px rgba(0,0,0,0.15)',
          }}
        >
          {/* All option */}
          <Box
            as="label"
            sx={{
              display: 'flex',
              alignItems: 'center',
              gap: 2,
              px: 2,
              py: '5px',
              cursor: 'pointer',
              fontSize: '13px',
              color: 'fg.default',
              borderBottom: '1px solid',
              borderColor: 'border.muted',
              mb: 1,
              '&:hover': { backgroundColor: 'canvas.subtle' },
            }}
          >
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
              style={{ cursor: 'pointer' }}
            />
            <Text sx={{ fontSize: '13px', fontWeight: 'semibold' }}>All</Text>
          </Box>

          {/* Individual options */}
          {options.map((opt) => (
            <Box
              as="label"
              key={opt.value}
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 2,
                px: 2,
                py: '4px',
                cursor: 'pointer',
                fontSize: '13px',
                color: 'fg.default',
                '&:hover': { backgroundColor: 'canvas.subtle' },
              }}
            >
              <input
                type="checkbox"
                checked={selected.has(opt.value)}
                onChange={() => toggleOption(opt.value)}
                style={{ cursor: 'pointer' }}
              />
              <Text sx={{ fontSize: '13px' }}>{opt.label}</Text>
            </Box>
          ))}
        </Box>
      )}
    </Box>
  );
}
