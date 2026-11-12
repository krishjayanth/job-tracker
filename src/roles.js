// What kind of role a job title describes, and at what level, for grouping how your
// applications went (see insights.js). Reading skills out of resumes and job descriptions
// is left to the AI. The first match wins, so the more specific kinds come first
// ("Data Engineer" is Data, not general Software).
const FUNCTIONS = [
  ['Machine learning', /\b(machine learning|ml|ai|artificial intelligence|deep learning|nlp|computer vision)\b/i],
  ['Quant and trading', /\b(quant|quantitative|trader|trading)\b/i],
  // A data center is infrastructure, not data work.
  ['Data', /\b(data(?!\s+cent(?:er|re))|analytics|analyst|business intelligence|bi)\b/i],
  ['Mobile', /\b(mobile|ios|android)\b/i],
  ['Frontend', /\b(front[- ]?end|ui engineer|web developer|web engineer)\b/i],
  ['Full stack', /\b(full[- ]?stack)\b/i],
  // "Server" alone is as often a restaurant job as a backend one.
  ['Backend', /\b(back[- ]?end|server[- ]side|api)\b/i],
  ['Infrastructure', /\b(platform|infrastructure|cloud|site reliability|sre|devops|systems engineer|data cent(?:er|re))\b/i],
  ['Embedded and robotics', /\b(embedded|firmware|robotics|hardware)\b/i],
  ['Security', /\b(security|cyber)\b/i],
  ['Games', /\b(game|games|gameplay)\b/i],
  ['Research', /\b(research)\b/i],
  ['Product and design', /\b(product manager|product designer|designer|ux|ui\/ux)\b/i],
];
const LEVELS = [
  ['Internship', /\b(intern|internship|co-?op|placement|summer)\b/i],
  // Only managers of engineers: a Product Manager or Account Manager can be any level.
  ['Senior', /\b(senior|sr\.?|staff|lead|principal|engineering manager|director|head of)\b/i],
  ['Early career', /\b(new grad|graduate|early career|junior|jr\.?|entry[- ]level|associate|engineer i|developer i|software engineer 1)\b/i],
];

export function roleFunction(title) {
  if (!title) return 'Not known';
  return FUNCTIONS.find(([, re]) => re.test(title))?.[0] ?? 'General software';
}

export function roleLevel(title) {
  if (!title) return 'Not known';
  return LEVELS.find(([, re]) => re.test(title))?.[0] ?? 'Mid-level';
}
