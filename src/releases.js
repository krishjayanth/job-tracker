// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-11-pdf-edits',
  title: "What's new in nuj",
  items: [
    {
      title: 'Your PDF stays on screen as you fix it',
      text: "When you select \"Use this\" on a rewrite, your resume's PDF stays up with the new line drawn over the old one, instead of switching to plain text.",
    },
    {
      title: 'Download your edited PDF',
      text: 'Select "Download edited PDF" under your resume for a copy of your own file with the new lines written in, ready to send. The old wording is taken out, not just covered.',
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
