// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-11-latex',
  title: "What's new in nuj",
  items: [
    {
      title: "Rebuild your resume in Jake's LaTeX format",
      text: "Select \"Rebuild in Jake's format\" above your resume and nuj remakes it as LaTeX in the popular Jake's Resume template, then builds the PDF. Your words stay exactly as they were.",
    },
    {
      title: 'Fixes go straight into the LaTeX',
      text: 'On a LaTeX version, "Use this" changes the line in its LaTeX and builds the PDF again, so what you download is real LaTeX, not a patched copy. Edit LaTeX lets you change anything yourself.',
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
