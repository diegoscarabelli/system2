import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MultiSelectDropdown } from './MultiSelectDropdown';

afterEach(cleanup);

const options = [
  { value: 'a', label: 'Alpha' },
  { value: 'b', label: 'Beta' },
  { value: 'c', label: 'Gamma' },
];

function renderDropdown(selected: Set<string>, onChange = vi.fn()) {
  return {
    onChange,
    ...render(
      <MultiSelectDropdown
        label="items"
        options={options}
        selected={selected}
        onChange={onChange}
      />
    ),
  };
}

describe('MultiSelectDropdown', () => {
  describe('display label', () => {
    it('shows "All items" when all options are selected', () => {
      renderDropdown(new Set(['a', 'b', 'c']));
      expect(screen.getByText('All items')).toBeDefined();
    });

    it('shows capitalized label when nothing is selected', () => {
      renderDropdown(new Set());
      expect(screen.getByText('Items')).toBeDefined();
    });

    it('shows single option label when one is selected', () => {
      renderDropdown(new Set(['b']));
      expect(screen.getByText('Beta')).toBeDefined();
    });

    it('shows count when multiple (but not all) are selected', () => {
      renderDropdown(new Set(['a', 'c']));
      expect(screen.getByText('2 items')).toBeDefined();
    });
  });

  describe('toggle All', () => {
    it('deselects all when all are selected', () => {
      const { onChange } = renderDropdown(new Set(['a', 'b', 'c']));
      fireEvent.click(screen.getByText('All items'));
      const allCheckbox = screen.getByLabelText('All');
      fireEvent.click(allCheckbox);
      expect(onChange).toHaveBeenCalledWith(new Set());
    });

    it('selects all when none are selected', () => {
      const { onChange } = renderDropdown(new Set());
      fireEvent.click(screen.getByText('Items'));
      const allCheckbox = screen.getByLabelText('All');
      fireEvent.click(allCheckbox);
      expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
    });

    it('selects all when some are selected', () => {
      const { onChange } = renderDropdown(new Set(['a']));
      fireEvent.click(screen.getByText('Alpha'));
      const allCheckbox = screen.getByLabelText('All');
      fireEvent.click(allCheckbox);
      expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
    });
  });

  describe('toggle individual option', () => {
    it('adds an unselected option', () => {
      const { onChange } = renderDropdown(new Set(['a']));
      fireEvent.click(screen.getByText('Alpha'));
      fireEvent.click(screen.getByLabelText('Beta'));
      expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b']));
    });

    it('removes a selected option', () => {
      const { onChange } = renderDropdown(new Set(['a', 'b']));
      fireEvent.click(screen.getByText('2 items'));
      fireEvent.click(screen.getByLabelText('Alpha'));
      expect(onChange).toHaveBeenCalledWith(new Set(['b']));
    });

    it('allows deselecting the last option', () => {
      const { onChange } = renderDropdown(new Set(['a']));
      fireEvent.click(screen.getByText('Alpha'));
      fireEvent.click(screen.getByLabelText('Alpha'));
      expect(onChange).toHaveBeenCalledWith(new Set());
    });
  });

  describe('open/close', () => {
    it('opens dropdown on button click', () => {
      renderDropdown(new Set(['a', 'b', 'c']));
      expect(screen.queryByLabelText('All')).toBeNull();
      fireEvent.click(screen.getByText('All items'));
      expect(screen.getByLabelText('All')).toBeDefined();
    });

    it('closes on Escape', () => {
      renderDropdown(new Set(['a', 'b', 'c']));
      fireEvent.click(screen.getByText('All items'));
      expect(screen.getByLabelText('All')).toBeDefined();
      fireEvent.keyDown(document, { key: 'Escape' });
      expect(screen.queryByLabelText('All')).toBeNull();
    });

    it('closes on click outside', () => {
      renderDropdown(new Set(['a', 'b', 'c']));
      fireEvent.click(screen.getByText('All items'));
      expect(screen.getByLabelText('All')).toBeDefined();
      fireEvent.mouseDown(document.body);
      expect(screen.queryByLabelText('All')).toBeNull();
    });
  });

  describe('None option', () => {
    const optionsWithNone = [{ value: '', label: 'None' }, ...options];

    it('treats empty string as a valid selectable option', () => {
      const onChange = vi.fn();
      render(
        <MultiSelectDropdown
          label="items"
          options={optionsWithNone}
          selected={new Set(['', 'a', 'b', 'c'])}
          onChange={onChange}
        />
      );
      fireEvent.click(screen.getByText('All items'));
      fireEvent.click(screen.getByLabelText('None'));
      expect(onChange).toHaveBeenCalledWith(new Set(['a', 'b', 'c']));
    });

    it('shows "All items" only when None is also selected', () => {
      const { rerender } = render(
        <MultiSelectDropdown
          label="items"
          options={optionsWithNone}
          selected={new Set(['a', 'b', 'c'])}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText('3 items')).toBeDefined();

      rerender(
        <MultiSelectDropdown
          label="items"
          options={optionsWithNone}
          selected={new Set(['', 'a', 'b', 'c'])}
          onChange={vi.fn()}
        />
      );
      expect(screen.getByText('All items')).toBeDefined();
    });
  });
});
