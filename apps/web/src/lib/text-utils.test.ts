import { describe, expect, it } from 'vitest';
import { newShot } from './shot-defaults';
import { parseLyrics, shotListCsv } from './text-utils';

describe('parseLyrics', () => {
  it('reads LRC timestamps, including repeated tags', () => {
    const lines = parseLyrics('[00:12.40]First line\n[00:15.00][01:02.5]Chorus\n[00:20]', 90);
    expect(lines.map((l) => [l.start, l.text])).toEqual([
      [12.4, 'First line'],
      [15, 'Chorus'],
      [62.5, 'Chorus'],
    ]);
    expect(lines[0]!.end).toBe(15);
    expect(lines[2]!.end).toBe(66.5);
  });

  it('spreads untimed lyrics across the song', () => {
    const lines = parseLyrics('One\n\n[Chorus]\nTwo\nThree\nFour', 40);
    expect(lines).toHaveLength(4);
    expect(lines[0]).toMatchObject({ start: 0, end: 10, text: 'One' });
    expect(lines[3]).toMatchObject({ start: 30, end: 40 });
  });
});

describe('shotListCsv', () => {
  it('orders by scene then shot and escapes cells', () => {
    const scenes = [
      { id: 'b', order: 2, number: '2', heading: 'EXT. BEACH - DAY' },
      { id: 'a', order: 1, number: '1', heading: 'INT. HOUSE - NIGHT' },
    ] as never[];
    const shots = [
      { ...newShot({ sceneId: 'b', order: 1, number: '2A', title: 'Wide' }), id: 's2' },
      { ...newShot({ sceneId: 'a', order: 2, number: '1B', title: 'Close, "tight"' }), id: 's1' },
    ];
    const csv = shotListCsv(scenes, shots).trim().split('\n');
    expect(csv[0]).toMatch(/^Scene,Heading,Shot,Title/);
    expect(csv[1]).toContain('INT. HOUSE - NIGHT,1B,"Close, ""tight"""');
    expect(csv[2]).toContain('EXT. BEACH - DAY,2A,Wide');
  });
});
