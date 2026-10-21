import ExcelJS from 'exceljs';

const STAGE_LABEL = {
  applied: 'Applied', oa: 'Assessment', interview: 'Interview', offer: 'Offer', rejected: 'Rejected', withdrawn: 'Withdrawn',
};
const STAGE_FILL = {
  applied: 'FFE0E7FF', oa: 'FFE0F2FE', interview: 'FFFEF3C7', offer: 'FFD1FAE5', rejected: 'FFFEE2E2', withdrawn: 'FFF1F5F9',
};

const decode = s => (s || '')
  .replace(/&#39;|&rsquo;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');
const gmailLink = id => `https://mail.google.com/mail/u/0/#all/${id}`;

function styleSheet(ws) {
  const header = ws.getRow(1);
  header.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  header.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4F46E5' } };
  header.alignment = { vertical: 'middle' };
  header.height = 22;
  ws.views = [{ state: 'frozen', ySplit: 1 }];
  ws.autoFilter = { from: { row: 1, column: 1 }, to: { row: 1, column: ws.columnCount } };
}

// Builds an .xlsx with one row per application plus a sheet of every email event.
export async function buildWorkbook(applications) {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'nuj';
  wb.created = new Date();

  const apps = wb.addWorksheet('Applications');
  apps.columns = [
    { header: 'Company', key: 'company', width: 26 },
    { header: 'Role', key: 'role', width: 44 },
    { header: 'Job ID', key: 'jobId', width: 16 },
    { header: 'Status', key: 'status', width: 13 },
    { header: 'Applied', key: 'applied', width: 13, style: { numFmt: 'mmm d, yyyy' } },
    { header: 'Last update', key: 'last', width: 13, style: { numFmt: 'mmm d, yyyy' } },
    { header: 'Latest email', key: 'latest', width: 56 },
    { header: 'Emails', key: 'emails', width: 9 },
    { header: 'Source', key: 'source', width: 9 },
    { header: 'Job posting', key: 'url', width: 30 },
    { header: 'Notes', key: 'notes', width: 40 },
  ];
  for (const a of applications) {
    const row = apps.addRow({
      company: a.company,
      role: a.role,
      jobId: a.jobId,
      status: STAGE_LABEL[a.status],
      applied: new Date(a.appliedAt),
      last: new Date(a.lastActivity),
      latest: decode(a.events.at(-1)?.subject),
      emails: a.events.filter(e => e.messageId).length,
      source: a.source === 'gmail' ? 'Gmail' : 'Manual',
      url: a.url ? { text: a.url, hyperlink: a.url } : '',
      notes: a.notes,
    });
    row.getCell('status').fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: STAGE_FILL[a.status] } };
  }
  styleSheet(apps);

  const timeline = wb.addWorksheet('Timeline');
  timeline.columns = [
    { header: 'Date', key: 'date', width: 18, style: { numFmt: 'mmm d, yyyy h:mm AM/PM' } },
    { header: 'Company', key: 'company', width: 26 },
    { header: 'Role', key: 'role', width: 36 },
    { header: 'Stage', key: 'stage', width: 13 },
    { header: 'Subject', key: 'subject', width: 60 },
    { header: 'From', key: 'from', width: 36 },
    { header: 'Email', key: 'link', width: 14 },
  ];
  const events = applications
    .flatMap(a => a.events.map(e => ({ a, e })))
    .sort((x, y) => y.e.date.localeCompare(x.e.date));
  for (const { a, e } of events) {
    timeline.addRow({
      date: new Date(e.date),
      company: a.company,
      role: a.role,
      stage: STAGE_LABEL[e.stage] + (e.manual ? ' (set by you)' : ''),
      subject: decode(e.subject),
      from: e.from || '',
      link: e.messageId ? { text: 'Open in Gmail', hyperlink: gmailLink(e.messageId) } : '',
    });
  }
  styleSheet(timeline);

  return wb.xlsx.writeBuffer();
}
