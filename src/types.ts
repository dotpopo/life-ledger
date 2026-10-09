import type { GroupKey } from './data/groups.js';

export interface CardRecord {
  id: string;
  chapter: string;
  chapterTitle: string;
  group: GroupKey;
  num: number;
  title: string;
  tags: {
    money: string;
    time: string;
    will: string;
    gain: string;
    lens: string;
  };
  grade: string;
  costText: string;
  plain: string;
  gainText: string;
  note: string;
  sources: Array<{ text: string; links: string[] }>;
}

export interface Corpus {
  source: {
    name: string;
    repo: string;
    author: string;
    license: string;
    licenseUrl: string;
    note: string;
  };
  generatedAt: string;
  stats: {
    cards: number;
    chapters: number;
    byGroup: Record<string, number>;
    byGrade: Record<string, number>;
  };
  chapters: Array<{ id: string; title: string; group: GroupKey; count: number }>;
  cards: CardRecord[];
}
