const DEFAULT_BASE_URL = 'https://api.getpostman.com';
const EU_BASE_URL = 'https://api.eu.postman.com';

const POLL_INTERVAL_MS = 2500;
const POLL_TIMEOUT_MS = 60_000;

export function getApiBaseUrl() {
  if (process.env.POSTMAN_API_BASE_URL?.trim()) {
    return process.env.POSTMAN_API_BASE_URL.trim().replace(/\/$/, '');
  }

  return process.env.POSTMAN_REGION?.trim().toLowerCase() === 'eu'
    ? EU_BASE_URL
    : DEFAULT_BASE_URL;
}

export function requireApiKey() {
  const apiKey = process.env.POSTMAN_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('POSTMAN_API_KEY environment variable is required.');
  }
  return apiKey;
}

export function createPostmanClient() {
  const apiKey = requireApiKey();
  const baseUrl = getApiBaseUrl();

  async function request(path, { method = 'GET', body, query } = {}) {
    const url = new URL(`${baseUrl}${path}`);

    if (query) {
      for (const [key, value] of Object.entries(query)) {
        if (value !== undefined && value !== null && value !== '') {
          url.searchParams.set(key, String(value));
        }
      }
    }

    const response = await fetch(url, {
      method,
      headers: {
        'X-API-Key': apiKey,
        Accept: 'application/json',
        ...(body ? { 'Content-Type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await response.text();
    let payload = null;

    if (text) {
      try {
        payload = JSON.parse(text);
      } catch {
        payload = text;
      }
    }

    if (!response.ok) {
      const detail =
        typeof payload === 'object' && payload !== null
          ? JSON.stringify(payload)
          : String(payload ?? response.statusText);
      throw new Error(
        `${method} ${url.pathname} failed (${response.status}): ${detail}`,
      );
    }

    return { status: response.status, data: payload };
  }

  async function getAllPages(path, { itemsKey, query = {} } = {}) {
    const items = [];
    let cursor = query.cursor;

    do {
      const pageQuery = { ...query, limit: query.limit ?? 100 };
      if (cursor) {
        pageQuery.cursor = cursor;
      }

      const { data } = await request(path, { query: pageQuery });
      const pageItems = data?.[itemsKey] ?? [];
      items.push(...pageItems);
      cursor = data?.meta?.nextCursor ?? null;
    } while (cursor);

    return items;
  }

  async function getMe() {
    const { data } = await request('/me');
    return data;
  }

  async function listWorkspaceSpecs(workspaceId) {
    return getAllPages('/specs', {
      itemsKey: 'specs',
      query: { workspaceId },
    });
  }

  async function listGeneratedCollections(specId) {
    return getAllPages(`/specs/${specId}/generations/collection`, {
      itemsKey: 'collections',
    });
  }

  async function generateCollection(specId, { name, options }) {
    return request(`/specs/${specId}/generations/collection`, {
      method: 'POST',
      body: { name, options },
    });
  }

  async function syncCollectionWithSpec(collectionUid, specId) {
    return request(`/collections/${collectionUid}/synchronizations`, {
      method: 'PUT',
      query: { specId },
    });
  }

  async function getCollection(collectionId) {
    const { data } = await request(`/collections/${collectionId}`);
    return data?.collection ?? data;
  }

  async function resolveCollectionUid(collectionId) {
    if (/^\d+-/.test(collectionId)) {
      return collectionId;
    }

    const collection = await getCollection(collectionId);
    if (collection?.uid) {
      return collection.uid;
    }

    const me = await getMe();
    const ownerId = me?.user?.id;
    if (!ownerId) {
      throw new Error(
        `Could not resolve collection UID for collection ${collectionId}.`,
      );
    }

    return `${ownerId}-${collectionId}`;
  }

  async function pollTask(taskUrl, { label }) {
    const deadline = Date.now() + POLL_TIMEOUT_MS;
    const path = taskUrl.startsWith('http')
      ? new URL(taskUrl).pathname
      : taskUrl;

    while (Date.now() < deadline) {
      const { data } = await request(path);
      const status = String(data?.status ?? '').toLowerCase();

      if (status === 'successful' || status === 'success' || status === 'completed') {
        return data;
      }

      if (status === 'failed' || status === 'error') {
        throw new Error(
          `${label} task failed: ${JSON.stringify(data)}`,
        );
      }

      await sleep(POLL_INTERVAL_MS);
    }

    throw new Error(`${label} task timed out after ${POLL_TIMEOUT_MS}ms.`);
  }

  async function pollCollectionUpdateTask(taskId, { label }) {
    return pollTask(`/collection-updates-tasks/${taskId}`, { label });
  }

  return {
    baseUrl,
    request,
    listWorkspaceSpecs,
    listGeneratedCollections,
    generateCollection,
    syncCollectionWithSpec,
    resolveCollectionUid,
    pollTask,
    pollCollectionUpdateTask,
  };
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export const DEFAULT_GENERATION_OPTIONS = {
  requestNameSource: 'Fallback',
  indentCharacter: 'Space',
  folderStrategy: 'Paths',
  parametersResolution: 'Example',
  includeAuthInfoInExample: true,
  enableOptionalParameters: true,
  keepImplicitHeaders: false,
  includeDeprecated: true,
  alwaysInheritAuthentication: false,
  nestedFolderHierarchy: false,
};
