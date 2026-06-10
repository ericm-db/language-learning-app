import { describe, expect, it } from 'vitest';
import { romanize } from './romanize';

describe('romanize', () => {
  it('transliterates known Telugu strings to IAST', () => {
    expect(romanize('నమస్తే')).toBe('namaste');
    expect(romanize('నేను బాగున్నాను')).toBe('nenu bāgunnānu');
    expect(romanize('మీరు ఎలా ఉన్నారు?')).toBe('mīru èlā unnāru?');
  });

  it('returns the empty string for empty input', () => {
    expect(romanize('')).toBe('');
  });

  it('passes Latin text and digits through unchanged', () => {
    expect(romanize('hello world 123')).toBe('hello world 123');
  });

  it('romanizes mixed Telugu and ASCII content', () => {
    expect(romanize('నీళ్లు కావాలి 123')).toBe('nīl̤lu kāvāli 123');
  });

  it('is deterministic for repeated calls', () => {
    const sample = 'మీరు ఎలా ఉన్నారు?';
    expect(romanize(sample)).toBe(romanize(sample));
  });
});
