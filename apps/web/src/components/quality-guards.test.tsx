import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Tooltip } from 'radix-ui';
import type { LikenessVerdict } from '@az-studio/shared';
import { BrandWarnings, LikenessNote } from './quality-guards';

afterEach(cleanup);

const verdict = (v: LikenessVerdict['verdict']): LikenessVerdict => ({ verdict: v, faceMatch: v !== 'fail', outfitMatch: v === 'pass', differences: v === 'fail' ? ['Ama: red dress'] : [], characters: [], checkedAt: 1, modelId: 'm' });
const wrap = (ui: React.ReactNode) => render(<Tooltip.Provider>{ui}</Tooltip.Provider>);

describe('brand warnings', () => {
  it('shows nothing for a safe brief, and the safer wording on request', () => {
    const { container } = wrap(<BrandWarnings text="A calm lake at dawn" />);
    expect(container.textContent).toBe('');
    const onApply = vi.fn();
    wrap(<BrandWarnings text="A man on a motorbike" onApply={onApply} />);
    expect(screen.getByRole('status').textContent).toMatch(/motorbike/);
    fireEvent.click(screen.getByRole('button', { name: /safer wording/i }));
    expect(onApply.mock.calls[0]![0]).toMatch(/plain unbranded motorbike/);
  });
});

describe('likeness verdict on a shot', () => {
  it('shows the verdict of the shot’s image and says when the newest still was kept aside', () => {
    wrap(<LikenessNote generated={[{ assetId: 'new', likeness: verdict('fail') }, { assetId: 'old', likeness: verdict('pass') }]} imageId="old" />);
    expect(screen.getByText('Likeness OK')).toBeTruthy();
    expect(screen.getByText(/kept as a candidate, not approved/)).toBeTruthy();
    cleanup();
    const { container } = wrap(<LikenessNote generated={[{ assetId: 'a' }]} imageId="a" />);
    expect(container.textContent).toBe('');
  });
});
