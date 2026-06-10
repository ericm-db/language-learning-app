import type { ReactElement } from 'react';
import { useDrillStore, type UtteranceRow } from '../store/drillStore';
import type { TranslationDirection } from '../ports/types';
import { romanize } from './romanize';

interface PaneEntry {
  key: string;
  en: string;
  te: string;
  finalized: boolean;
}

function englishSide(direction: TranslationDirection, input: string, output: string): string {
  return direction.source === 'en' ? input : output;
}

function teluguSide(direction: TranslationDirection, input: string, output: string): string {
  return direction.source === 'te' ? input : output;
}

function toEntry(row: UtteranceRow): PaneEntry {
  return {
    key: row.id,
    en: englishSide(row.direction, row.inputText, row.outputText),
    te: teluguSide(row.direction, row.inputText, row.outputText),
    finalized: row.finalized,
  };
}

function Pane({
  title,
  lang,
  entries,
  text,
}: {
  title: string;
  lang: 'en' | 'te';
  entries: PaneEntry[];
  text: (entry: PaneEntry) => string;
}): ReactElement {
  return (
    <div className="pane">
      <h2 className="pane-title">{title}</h2>
      <div className="pane-body">
        {entries.map((entry) => {
          const value = text(entry);
          if (value === '') return null;
          return (
            <p
              key={entry.key}
              lang={lang}
              className={`pane-line${lang === 'te' ? ' te te-large' : ''}${
                entry.finalized ? '' : ' pane-line-partial'
              }`}
            >
              {value}
            </p>
          );
        })}
      </div>
    </div>
  );
}

export function TranscriptPanes(): ReactElement {
  const utterances = useDrillStore((s) => s.utterances);
  const partialInput = useDrillStore((s) => s.partialInput);
  const partialOutput = useDrillStore((s) => s.partialOutput);
  const direction = useDrillStore((s) => s.direction);

  const entries = utterances.filter((row) => row.finalized).map(toEntry);

  // Partials stream straight in (budget: transcript -> screen < 100 ms).
  const liveEn = englishSide(direction, partialInput, partialOutput);
  const liveTe = teluguSide(direction, partialInput, partialOutput);
  if (liveEn !== '' || liveTe !== '') {
    entries.push({ key: 'live', en: liveEn, te: liveTe, finalized: false });
  }

  return (
    <section className="panes" aria-label="Transcripts">
      <Pane title="English" lang="en" entries={entries} text={(e) => e.en} />
      <Pane title="Telugu" lang="te" entries={entries} text={(e) => e.te} />
      <Pane title="Romanization" lang="en" entries={entries} text={(e) => romanize(e.te)} />
    </section>
  );
}
