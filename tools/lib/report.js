'use strict';

const { esc, code, bytes } = require('./markdown');

const MARKER = '<!-- registry-validation -->';
const MAX_COMMENT_CHARS = 60000;
const LABEL = { pass: 'PASS', warn: 'PASS with warnings', incomplete: 'INCOMPLETE', fail: 'FAIL' };

function list(items, limit = 30) {
  const shown = items.slice(0, limit).map((item) => `- ${item.where && item.where !== '/' ? `${code(item.where, 80)} ` : ''}${esc(item.message)}`);
  if (items.length > limit) shown.push(`- and ${items.length - limit} more`);
  return shown.join('\n');
}

function mirrorLine(mirror, index) {
  const state = mirror.state === 'ok' ? 'serves every pinned file' : mirror.state === 'unreachable' ? 'not reachable' : `${mirror.failed} of ${mirror.ok + mirror.failed} pinned files failed`;
  return `${index + 1}. ${code(mirror.url)}: ${state}`;
}

function fileRows(files) {
  const rows = ['| File | Role | Size | Mirrors |', '| --- | --- | --- | --- |'];
  for (const file of files) {
    const outcome = file.mirrors.map((item) => (item.state === 'ok' ? 'ok' : item.state)).join(', ');
    rows.push(`| ${code(file.path, 100)} | ${esc(file.role)} | ${file.size === null ? '-' : bytes(file.size)} | ${esc(outcome)} |`);
  }
  return rows.join('\n');
}

function renderEntry(entry, options) {
  const out = [];
  const title = entry.id ? `${code(entry.id)}${entry.name ? ` ${esc(entry.name, 60)}` : ''}` : code(entry.file);
  out.push(`### ${title}: ${LABEL[entry.verdict]}`);
  const facts = [];
  if (entry.status) facts.push(`status ${code(entry.status)}${entry.status === 'approved' ? ' (merging this pull request approves the entry)' : ''}`);
  facts.push(entry.isNew ? 'new entry' : 'existing entry');
  out.push(facts.join(', '));
  if (entry.changes.length) out.push(`\n**Changes against the base branch**\n${entry.changes.slice(0, 30).map((line) => `- ${esc(line)}`).join('\n')}${entry.changes.length > 30 ? `\n- and ${entry.changes.length - 30} more` : ''}`);

  if (entry.networkChecked) {
    out.push('\n**Mirrors**\n' + entry.mirrors.map(mirrorLine).join('\n'));
    const verified = entry.files.filter((file) => file.verified).length;
    out.push(`\n**Pinned files**: ${verified} of ${entry.files.length} verified on at least one mirror.`);
    for (const manifest of entry.manifests) {
      const note = manifest.kind === 'game' ? 'game manifest, files not downloaded' : `${bytes(manifest.declaredBytes)} listed`;
      out.push(`- ${code(manifest.path)}: ${manifest.entries} files, ${note}${manifest.problems ? `, ${manifest.problems} parse problems` : ''}`);
    }
    const { listed } = entry;
    if (listed.checked > 0) {
      out.push(`\n**Files listed in manifests**: ${listed.ok} of ${listed.checked} downloaded and matched (${bytes(listed.bytes)})${listed.skipped ? `, ${listed.skipped} not verified (time budget)` : ''}${listed.failed ? `, ${listed.failed} failed` : ''}.`);
    }
    if (entry.display.length) out.push(`\n**Display files**: ${entry.display.map((item) => `${code(item.path, 60)} (${esc(item.role)}) ${item.ok ? 'ok' : 'failed'}`).join(', ')}`);
    const eligible = entry.scanTargets.length;
    if (eligible) out.push(`\n${eligible} distinct code-bearing files are eligible for the VirusTotal scan.`);
  }

  if (entry.errors.length) out.push(`\n**Errors (${entry.errors.length})**\n${list(entry.errors)}`);
  if (entry.warnings.length) out.push(`\n**Warnings (${entry.warnings.length})**\n${list(entry.warnings)}`);
  if (entry.networkChecked && !options.compact) out.push(`\n<details><summary>Pinned files</summary>\n\n${fileRows(entry.files)}\n\n</details>`);
  return out.join('\n');
}

/** Renders the whole comment from a validation run. Never longer than the limit of a pull request comment. */
function renderComment(run) {
  for (const compact of [false, true]) {
    const failures = run.entries.filter((entry) => entry.verdict === 'fail').length + (run.problems || []).filter((item) => item.level === 'error').length;
    const warned = run.entries.filter((entry) => entry.verdict === 'warn' || entry.verdict === 'incomplete').length;
    const headline = failures ? `FAIL: ${failures} problem${failures === 1 ? '' : 's'} to fix` : warned ? 'PASS with warnings' : run.entries.length ? 'PASS' : 'Nothing to validate';
    const out = [MARKER, `## Registry validation: ${headline}`];
    out.push(`Commit ${code(String(run.commit || '').slice(0, 12))}. This comment is updated in place on every push.`);
    for (const problem of run.problems || []) out.push(`\n**${problem.level === 'error' ? 'Error' : 'Warning'}**: ${esc(problem.message)}`);
    for (const entry of run.entries) out.push('\n' + renderEntry(entry, { compact }));
    if (run.removed && run.removed.length) out.push(`\n**Removed entries**: ${run.removed.map((name) => code(name)).join(', ')}`);
    out.push('\nCI checks structure, links and hashes. It does not replace review: a maintainer still reads the change.');
    const text = out.join('\n');
    if (text.length <= MAX_COMMENT_CHARS) return text;
    if (compact) return text.slice(0, MAX_COMMENT_CHARS - 200) + '\n\n_The comment was cut because it is too long; see the workflow run for the full result._';
  }
  return '';
}

module.exports = { renderComment, MARKER, MAX_COMMENT_CHARS };
