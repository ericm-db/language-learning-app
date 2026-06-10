// Deterministic EN <-> TE sentence pairs used by FakeTranslationAdapter.
// Exported so UI demos can show users what to say in offline mode.

export interface CannedPair {
  en: string;
  /** Colloquial Telugu in Telugu script. */
  te: string;
}

export const CANNED_PAIRS: readonly CannedPair[] = [
  { en: 'Hello, how are you?', te: 'హలో, ఎలా ఉన్నారు?' },
  { en: 'Good morning, did you sleep well?', te: 'శుభోదయం, బాగా నిద్రపోయారా?' },
  { en: 'My name is Ravi. What is your name?', te: 'నా పేరు రవి. మీ పేరు ఏమిటి?' },
  { en: 'I am very hungry.', te: 'నాకు చాలా ఆకలిగా ఉంది.' },
  { en: 'This curry is very tasty.', te: 'ఈ కూర చాలా రుచిగా ఉంది.' },
  { en: 'I want one cup of tea, please.', te: 'నాకు ఒక కప్పు టీ కావాలి.' },
  { en: 'Where is the bus stand?', te: 'బస్ స్టాండ్ ఎక్కడ ఉంది?' },
  { en: 'Go straight and turn left.', te: 'నేరుగా వెళ్ళి ఎడమవైపు తిరగండి.' },
  { en: 'How far is the railway station from here?', te: 'ఇక్కడి నుంచి రైల్వే స్టేషన్ ఎంత దూరం?' },
  { en: 'Thank you very much, see you tomorrow.', te: 'చాలా ధన్యవాదాలు, రేపు కలుద్దాం.' },
];
