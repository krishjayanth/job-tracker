// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-10-dashboard',
  title: "What's new in nuj",
  items: [
    {
      title: 'Smarter sorting',
      text: "nuj now checks an email is about a job before adding it, so rental, utility, bank and school “applications” stay out. It's also better at telling apart several applications at the same company.",
    },
    {
      title: 'A calmer dashboard',
      text: 'A cleaner layout with your pipeline at the top, a chart you can click to filter, and a light theme when your device uses one.',
    },
    {
      title: 'Fixing a mis-filed email',
      text: '“Filed correctly?” on any email gives three answers: Yes, Move it, or Not a job. Not a job can also ignore that sender for good.',
    },
    {
      title: 'Undo',
      text: 'Deleting, moving and removing happen straight away, with Undo for five seconds.',
    },
    {
      title: 'Settings and help',
      text: 'Gmail, AI sorting, ignored senders and your account are in one Settings page. If something looks wrong, use Report a problem.',
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
