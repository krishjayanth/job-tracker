// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-11-needs-your-action',
  title: "What's new in nuj",
  items: [
    {
      title: 'Interviews and offers in Needs your action',
      text: "Interviews in the next two weeks and new offers now show up in Needs your action, next to your deadlines. Add an interview's date and time in its application to see it there.",
    },
    {
      title: 'Clearer stages',
      text: 'The tab for applications still waiting on a first reply is now called Awaiting reply, and the chart shows Ongoing for ones still under way.',
    },
    {
      title: 'Close quiet applications at once',
      text: "On the No response tab you can mark everything that's gone quiet as withdrawn in one go, and undo it if you change your mind.",
    },
    {
      title: 'Applications has its own page',
      text: 'Applications in the sidebar now opens just your list, without the chart and summary above it.',
    },
    {
      title: 'Undo keeps working after an update',
      text: 'If nuj is updated right after you delete or move something, Undo still puts it back.',
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
