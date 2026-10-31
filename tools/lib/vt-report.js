'use strict';

const { esc, code, bytes } = require('./markdown');
const { detections } = require('./virustotal');

const MARKER = '<!-- registry-virustotal -->';
const LABEL = {
  flagged: 'at or above the threshold',
  detections: 'some detections',
  clean: 'no detections',
  benign: 'known benign',
  queued: 'queued (quota)',
  'analysis-pending': 'uploaded, analysis pending',
  'too-large': 'unknown, too large to upload',
  unknown: 'game file not known to VirusTotal',
  error: 'lookup failed'
};

function renderSkipped(reason) {
  return `${MARKER}\n## VirusTotal: not run\n\n${esc(reason)}\n`;
}

/** `entries`: [{ id, files: [scan results], problems }]. A signal for the reviewer, never a verdict. */
function renderScan(entries, { threshold, remainingToday, commit }) {
  const all = entries.flatMap((entry) => entry.files);
  const count = (status) => all.filter((file) => file.status === status).length;
  const flagged = count('flagged');
  const out = [MARKER, `## VirusTotal: ${flagged ? `${flagged} file${flagged === 1 ? '' : 's'} for a maintainer to look at` : 'no file at or above the threshold'}`];
  out.push(`Commit ${code(String(commit || '').slice(0, 12))}. This is a signal for the reviewer, not a verdict: BepInEx and similar loaders are flagged by a few engines because of what they do, and a clean scan proves little about new code. The threshold is ${threshold} detecting engines (malicious plus suspicious).`);
  out.push(`\n${all.length} distinct files: ${['flagged', 'detections', 'clean', 'benign', 'unknown', 'queued', 'analysis-pending', 'too-large', 'error'].map((status) => `${count(status)} ${LABEL[status]}`).filter((text) => !text.startsWith('0 ')).join(', ') || 'none'}.`);
  const waiting = count('queued') + count('analysis-pending');
  if (waiting) out.push(`\n${waiting} files are waiting for the free-tier quota (4 requests a minute, 500 a day; ${remainingToday} requests left for pull requests today). Re-run the job later; finished results are cached.`);
  if (count('too-large')) out.push('\nFiles over the upload cap are not sent to VirusTotal when it does not know them; look at them by hand.');

  for (const entry of entries) {
    const interesting = entry.files.filter((file) => ['flagged', 'detections', 'unknown', 'queued', 'analysis-pending', 'too-large', 'error'].includes(file.status));
    out.push(`\n### ${code(entry.id)}`);
    for (const problem of entry.problems || []) out.push(`- ${esc(problem)}`);
    if (!interesting.length) {
      out.push('Nothing to look at.');
      continue;
    }
    out.push('| File | Size | Engines | Result |', '| --- | --- | --- | --- |');
    for (const file of interesting.slice(0, 40)) {
      const engines = file.total ? `${detections(file)} of ${file.total}` : '-';
      out.push(`| ${code(file.paths[0], 90)} | ${bytes(file.size)} | ${engines} | ${esc(LABEL[file.status])}${file.note ? `: ${esc(file.note, 80)}` : ''} |`);
    }
    if (interesting.length > 40) out.push(`\nand ${interesting.length - 40} more`);
    out.push(`\n${interesting.slice(0, 5).map((file) => `[${code(file.sha256.slice(0, 12))}](https://www.virustotal.com/gui/file/${file.sha256})`).join(' ')}`);
  }
  return out.join('\n');
}

module.exports = { renderScan, renderSkipped, MARKER };
