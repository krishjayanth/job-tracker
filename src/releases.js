// What changed in the latest update, shown once to everyone who used nuj before it
// (see whatsNewFor in server.js). Give each release a new id; people who've seen
// that id don't see it again. Write it for the people using nuj, not for developers.
export const LATEST_RELEASE = {
  id: '2026-11-resume-grade',
  title: "What's new in nuj",
  items: [
    {
      title: 'Your resume, graded',
      text: 'Select "Grade my resume" for a strict recruiter\'s read: a score out of 100 and a letter grade, five rubric scores, every bullet that misses the XYZ formula with a rewrite, skills you list but never show, and the biggest thing holding it back.',
    },
    {
      title: 'Tailor it to a job',
      text: 'Check fit and Check a job now act as a recruiter for that company: a match score out of 100, the top missing keywords, three red flags, bullets rewritten for the job, and the sections a busy reader would skip.',
    },
    {
      title: 'Asked again before it runs',
      text: "The review now reads the job descriptions you've pasted, and Check fit tells the AI the company's name, so nuj asks your permission again the next time you use them. Your name and contact details are still never sent.",
    },
  ],
};

// The one-time re-read of everyone's emails with the new sorting (owner excepted).
// Change the id to run another one after a future change to sorting.
export const RESCAN_ID = 'rescan-2026-10-job-check';
