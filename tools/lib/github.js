'use strict';

const API = (process.env.GITHUB_API_URL || 'https://api.github.com').replace(/\/$/, '');

class GitHubError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'GitHubError';
    this.status = status;
  }
}

function client({ token, repository, apiUrl = API, fetchImpl = fetch }) {
  const headers = (accept = 'application/vnd.github+json') => ({
    accept,
    authorization: `Bearer ${token}`,
    'x-github-api-version': '2022-11-28',
    'user-agent': 'odinsons-registry-ci'
  });

  async function request(method, route, body, accept) {
    const response = await fetchImpl(`${apiUrl}${route}`, {
      method,
      headers: { ...headers(accept), ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined
    });
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      throw new GitHubError(response.status, `${method} ${route.split('?')[0]} failed with ${response.status}: ${text.slice(0, 300)}`);
    }
    return response.status === 204 ? null : response.json();
  }

  async function paginate(route, { pages = 10 } = {}) {
    const items = [];
    for (let page = 1; page <= pages; page++) {
      const batch = await request('GET', `${route}${route.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
      items.push(...batch);
      if (batch.length < 100) break;
    }
    return items;
  }

  /** Reads a blob as raw bytes and stops as soon as it exceeds `maxBytes` (returns null then). */
  async function readBlob(sha, maxBytes) {
    const response = await fetchImpl(`${apiUrl}/repos/${repository}/git/blobs/${encodeURIComponent(sha)}`, { headers: headers('application/vnd.github.raw+json') });
    if (!response.ok) throw new GitHubError(response.status, `Reading blob ${sha} failed with ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > maxBytes) {
        await response.body.cancel?.().catch(() => {});
        return null;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks);
  }

  /** Creates or edits the one comment that starts with `marker` and was written by the Actions bot. */
  async function upsertComment(number, marker, body) {
    const comments = await paginate(`/repos/${repository}/issues/${number}/comments`);
    const mine = comments.find((item) => item.user && item.user.login === 'github-actions[bot]' && item.body.startsWith(marker));
    if (mine) return request('PATCH', `/repos/${repository}/issues/comments/${mine.id}`, { body });
    return request('POST', `/repos/${repository}/issues/${number}/comments`, { body });
  }

  return { request, paginate, readBlob, upsertComment, repository };
}

module.exports = { client, GitHubError };
