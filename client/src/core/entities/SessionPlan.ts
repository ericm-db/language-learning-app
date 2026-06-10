// Ordered list of practice sentences for a drill.

export interface SessionPlan {
  current(): string | undefined;
  advance(): void;
  remaining(): number;
  isComplete(): boolean;
}

export function createSessionPlan(sentences: readonly string[]): SessionPlan {
  let index = 0;
  return {
    current: () => sentences[index],
    advance() {
      if (index < sentences.length) index += 1;
    },
    remaining: () => sentences.length - index,
    isComplete: () => index >= sentences.length,
  };
}
