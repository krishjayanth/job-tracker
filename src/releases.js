// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-11-resume-ai-only',
  title: "What's new in nuj",
  items: [
    {
      title: 'Resume insights is simpler',
      text: "Resume insights now keeps your resume versions and shows your resume, with the AI's suggestions marked on it. The rate charts, keyword lists and automatic checks are gone. Ask for suggestions, or use Check fit on an application, for advice on what to change.",
    },
    {
      title: 'Put a suggested rewrite straight into your resume',
      text: 'Select "Use this" beside a rewrite and nuj swaps that line in your resume for you. Undo puts it back.',
    },
    {
      title: 'Check a job before you apply',
      text: 'Paste a job description under your resume to see how well it fits and which lines to reword for it.',
    },
    {
      title: 'Compare two versions',
      text: 'Pick "Compare with" above your resume to see the lines one version added and took out.',
    },
    {
      title: 'Suggestions from day one',
      text: "AI suggestions now work as soon as you add your resume, before you've added any applications. Your name and contact details are no longer sent to OpenAI.",
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
