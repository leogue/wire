import { describe, expect, it } from 'vitest';
import { builtinParts } from '../src/index.ts';

describe('built-in parts', () => {
  it('are all valid', () => {
    const parts = builtinParts();
    expect([...parts.keys()]).toEqual(expect.arrayContaining(['R', 'C', 'LED', 'Q_NPN', 'PWR', 'GND', 'PWR_FLAG']));
    expect(parts.get('GND')).toMatchObject({ kind: 'power', net: 'GND' });
    expect(parts.get('R')).toMatchObject({ kind: 'tile', ref: 'R' });
  });
});
