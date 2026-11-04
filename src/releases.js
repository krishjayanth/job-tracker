// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-10-resume-insights',
  title: "What's new in nuj",
  items: [
    {
      title: 'Resume insights',
      text: 'Add your resume (a PDF, a Word file or pasted text) and see how often your applications move forward, by resume version and by kind of role. Find it in the sidebar.',
    },
    {
      title: 'Keywords from your postings',
      text: "See which skills the jobs you applied to ask for, and which of them your resume doesn't mention. Paste a job description into any application for better results.",
    },
    {
      title: 'Resume versions',
      text: 'Keep up to five versions. Each application counts toward the one you were sending when you applied, so you can see which version does better.',
    },
    {
      // Only shown when this server has AI for Resume insights (see whatsNewFor).
      needs: 'ai',
      title: 'Suggestions and Check fit',
      text: "Ask the AI what to change first, or how well your resume fits one job. It asks before sending anything, and you get a few a day.",
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
