// Accumulating builder the coordinator fills between UtteranceStarted and
// the port's turnComplete boundary.

import type { TranscriptDelta } from '../../ports/types';

export interface FinalizedUtterance {
  inputText: string;
  outputText: string;
}

export interface UtteranceBuilder {
  append(delta: TranscriptDelta): void;
  finalize(): FinalizedUtterance;
}

export function createUtteranceBuilder(): UtteranceBuilder {
  let inputText = '';
  let outputText = '';
  return {
    append(delta) {
      if (delta.side === 'input') inputText += delta.text;
      else outputText += delta.text;
    },
    finalize() {
      return { inputText: inputText.trim(), outputText: outputText.trim() };
    },
  };
}
